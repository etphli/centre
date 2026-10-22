import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { z } from 'zod';
import { attachmentSchema, type Attachment, type Chat } from '../shared/schema';
import { canShareChatAttachment } from '../shared/chat-lineage';
import { HttpError } from './errors';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARACTERS = 200_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_PDF_PAGES = 500;
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const attachmentUploadSchema = z.object({
  name: z.string().trim().min(1).max(200).refine(name => !/[\\/\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..', 'Use a filename without path separators or control characters.'),
  mimeType: z.string().max(200),
  data: z.string().min(4).max(28_000_000),
}).strict();

const textExtensions = new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.html','.htm','.xml','.yaml','.yml','.toml','.ini','.css','.js','.jsx','.mjs','.cjs','.ts','.tsx','.py','.java','.c','.h','.cc','.cpp','.hpp','.rs','.go','.rb','.php','.swift','.sh','.sql','.ipynb','.r','.tex','.log']);
const canonicalMimes: Record<string,string> = {
  '.txt':'text/plain', '.md':'text/markdown', '.markdown':'text/markdown', '.csv':'text/csv', '.tsv':'text/tab-separated-values',
  '.json':'application/json', '.html':'text/html', '.htm':'text/html', '.xml':'application/xml', '.yaml':'text/yaml', '.yml':'text/yaml', '.toml':'text/plain', '.ini':'text/plain', '.css':'text/css',
  '.js':'text/javascript', '.jsx':'text/javascript', '.mjs':'text/javascript', '.cjs':'text/javascript', '.ts':'text/typescript', '.tsx':'text/typescript', '.py':'text/x-python', '.java':'text/x-java-source', '.c':'text/x-c', '.h':'text/x-c', '.cc':'text/x-c++', '.cpp':'text/x-c++', '.hpp':'text/x-c++', '.rs':'text/x-rust', '.go':'text/x-go', '.rb':'text/x-ruby', '.php':'text/x-php', '.swift':'text/x-swift', '.sh':'text/x-shellscript', '.sql':'application/sql', '.ipynb':'application/json', '.r':'text/plain', '.tex':'application/x-tex', '.log':'text/plain',
  '.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
};
const supportedExtensions = new Set([...textExtensions, '.pdf','.docx','.png','.jpg','.jpeg','.webp']);
const publicMetadataSchema = attachmentSchema;
const storedMetadataSchema = attachmentSchema.extend({ extractedText:z.string().max(MAX_ATTACHMENT_TEXT_CHARACTERS).optional() });

type ExtractedAttachment = { attachment: Attachment; text?: string; imagePath?: string };

function fail(status: number, message: string): never { throw new HttpError(status, message); }

function decodeBase64(value: string): Buffer {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payloadLength = value.length - padding;
  if (value.length % 4 !== 0 || (padding === 1 && payloadLength % 4 !== 3) || (padding === 2 && payloadLength % 4 !== 2) || value.indexOf('=') !== (padding ? payloadLength : -1)) return fail(400, 'The attachment data is not valid base64.');
  for (let index = 0; index < payloadLength; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) return fail(400, 'The attachment data is not valid base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return fail(400, 'The attachment data is not valid base64.');
  if (decoded.length === 0) return fail(400, 'The selected file is empty.');
  if (decoded.length > MAX_ATTACHMENT_BYTES) return fail(413, 'Each attachment must be 20 MB or smaller.');
  return decoded;
}

function validateDocxArchive(bytes: Buffer) {
  const firstEndRecord = Math.max(0, bytes.length - 65_557);
  let endRecord = -1;
  for (let offset = bytes.length - 22; offset >= firstEndRecord; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break; }
  }
  if (endRecord < 0) return fail(400, 'This Word document is not a valid DOCX file.');
  const disk = bytes.readUInt16LE(endRecord + 4);
  const directoryDisk = bytes.readUInt16LE(endRecord + 6);
  const diskEntries = bytes.readUInt16LE(endRecord + 8);
  const entryCount = bytes.readUInt16LE(endRecord + 10);
  const directorySize = bytes.readUInt32LE(endRecord + 12);
  const directoryOffset = bytes.readUInt32LE(endRecord + 16);
  const commentLength = bytes.readUInt16LE(endRecord + 20);
  if (disk || directoryDisk || diskEntries !== entryCount || entryCount === 0 || entryCount > 1000 || entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff || endRecord + 22 + commentLength > bytes.length || directoryOffset + directorySize > endRecord) {
    return fail(400, 'This Word document uses an unsupported or invalid ZIP layout.');
  }
  let offset = directoryOffset;
  let totalExpanded = 0;
  let documentXmlFound = false;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return fail(400, 'This Word document has an invalid ZIP directory.');
    const flags = bytes.readUInt16LE(offset + 8);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const end = offset + 46 + filenameLength + extraLength + entryCommentLength;
    if (end > directoryOffset + directorySize || flags & 1 || expandedSize === 0xffffffff) return fail(400, 'This Word document contains an unsupported ZIP entry.');
    const filename = bytes.toString('utf8', offset + 46, offset + 46 + filenameLength);
    totalExpanded += expandedSize;
    if (totalExpanded > MAX_DOCX_UNCOMPRESSED_BYTES) return fail(413, 'This Word document expands beyond the safe 50 MB extraction limit.');
    if (filename === 'word/document.xml') {
      if (expandedSize > MAX_DOCX_DOCUMENT_BYTES) return fail(413, 'This Word document exceeds the 10 MB document text extraction limit.');
      documentXmlFound = true;
    }
    offset = end;
  }
  if (!documentXmlFound || offset !== directoryOffset + directorySize) return fail(400, 'This Word document is missing its main document content.');
}

function assertFileFormat(extension: string, mimeType: string, bytes: Buffer): string {
  const expected = canonicalMimes[extension];
  if (!supportedExtensions.has(extension) || !expected) return fail(415, 'This file type is not supported. Attach text, PDF, DOCX, PNG, JPEG, or WEBP files.');
  const supplied = mimeType.trim().toLowerCase().split(';')[0] ?? '';
  if (supplied && supplied !== expected && supplied !== 'application/octet-stream' && !(textExtensions.has(extension) && supplied === 'text/plain')) {
    return fail(400, 'The file type does not match its filename.');
  }
  if (extension === '.pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return fail(400, 'The selected file does not contain a valid PDF signature.');
  if (extension === '.docx') {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return fail(400, 'The selected file does not contain a valid DOCX signature.');
    validateDocxArchive(bytes);
  }
  if (extension === '.png' && !bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return fail(400, 'The selected file does not contain a valid PNG signature.');
  if ((extension === '.jpg' || extension === '.jpeg') && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return fail(400, 'The selected file does not contain a valid JPEG signature.');
  if (extension === '.webp' && !(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP')) return fail(400, 'The selected file does not contain a valid WEBP signature.');
  return expected;
}

function decodeText(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { return fail(400, 'This text attachment is not valid UTF-8.'); }
  if (text.includes('\u0000')) return fail(400, 'This text attachment contains binary data.');
  if (text.length > MAX_ATTACHMENT_TEXT_CHARACTERS) return fail(413, 'Text attachments must contain 200,000 characters or fewer.');
  return text;
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    loadingTask = getDocument({ data:new Uint8Array(bytes), stopAtErrors:true, verbosity:0 });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) return fail(413, 'PDF attachments are limited to 500 pages.');
    const pages: string[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => 'str' in item ? item.str : '').filter(Boolean).join(' ');
      length += pageText.length;
      if (length > MAX_ATTACHMENT_TEXT_CHARACTERS) return fail(413, 'PDF text exceeds the 200,000 character extraction limit.');
      pages.push(pageText);
      page.cleanup();
    }
    const text = pages.join('\n\n').trim();
    if (!text) return fail(422, 'This PDF has no selectable text to attach. Scanned PDFs need OCR before they can be used.');
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(400, 'Centre could not read this PDF. Check that it is not damaged or password protected.');
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  let result: Awaited<ReturnType<typeof mammoth.extractRawText>>;
  try { result = await mammoth.extractRawText({ buffer:bytes }); }
  catch { return fail(400, 'Centre could not read this Word document. Check that it is not damaged or password protected.'); }
  const text = result.value.trim();
  if (!text) return fail(422, 'This Word document contains no extractable text.');
  if (text.length > MAX_ATTACHMENT_TEXT_CHARACTERS) return fail(413, 'Word document text exceeds the 200,000 character extraction limit.');
  return text;
}

export class AttachmentStore {
  readonly directory: string;
  constructor(dataDirectory: string, readonly workspaceId = `desktop:${createHash('sha256').update(resolve(dataDirectory)).digest('hex')}`) { this.directory = join(resolve(dataDirectory), 'attachments'); }

  private metadataPath(id: string) { return join(this.directory, `${id}.json`); }
  private dataPath(id: string, name: string) { return join(this.directory, `${id}${extname(name).toLowerCase()}`); }
  private validId(id: string) { if (!z.string().uuid().safeParse(id).success) return fail(404, 'Attachment not found.'); }

  assertMessageOwnership(chats: readonly Chat[], attachmentIds: readonly string[], chatId: string): void {
    const scopedChats = chats.map(chat => ({ workspaceId: this.workspaceId, chat }));
    const target = { workspaceId: this.workspaceId, chatId };
    for (const attachmentId of attachmentIds) {
      const owners = chats.filter(chat => chat.messages.some(message => message.attachmentIds.includes(attachmentId)));
      if (owners.some(chat => !canShareChatAttachment(scopedChats, attachmentId, { workspaceId: this.workspaceId, chatId: chat.id }, target))) {
        fail(409, 'This attachment is not retained in this chat. Upload it again to attach a separate copy.');
      }
    }
  }

  async upload(value: unknown, stableId: string = randomUUID()): Promise<Attachment> {
    this.validId(stableId);
    const input = attachmentUploadSchema.parse(value);
    const extension = extname(input.name).toLowerCase();
    const bytes = decodeBase64(input.data);
    const mimeType = assertFileFormat(extension,input.mimeType,bytes);
    let extractedText: string | undefined;
    if (textExtensions.has(extension)) extractedText = decodeText(bytes);
    else if (extension === '.pdf') extractedText = await extractPdfText(bytes);
    else if (extension === '.docx') extractedText = await extractDocxText(bytes);
    await mkdir(this.directory, { recursive:true, mode:0o700 });
    const attachment = publicMetadataSchema.parse({ id:stableId,name:input.name,mimeType,size:bytes.length });
    const storedMetadata = storedMetadataSchema.parse({ ...attachment,...(extractedText === undefined ? {} : { extractedText }) });
    const dataPath = this.dataPath(attachment.id,attachment.name);
    let wroteData = false;
    let wroteMetadata = false;
    try {
      await writeFile(dataPath,bytes,{ flag:'wx', mode:0o600 });
      wroteData = true;
      await writeFile(this.metadataPath(attachment.id),JSON.stringify(storedMetadata),{ flag:'wx', mode:0o600 });
      wroteMetadata = true;
    } catch (error) {
      await Promise.all([wroteData ? unlink(dataPath).catch(() => undefined) : undefined,wroteMetadata ? unlink(this.metadataPath(attachment.id)).catch(() => undefined) : undefined]);
      throw error;
    }
    return attachment;
  }

  private async getStored(id: string) {
    this.validId(id);
    try { await readFile(join(this.directory,`${id}.deleted`)); return fail(404,'Attachment was deleted.'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    try {
      const parsed = storedMetadataSchema.parse(JSON.parse(await readFile(this.metadataPath(id),'utf8')));
      if (parsed.id !== id) return fail(404, 'Attachment not found.');
      return parsed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fail(404, 'Attachment not found.');
      return fail(500, 'Attachment metadata could not be read.');
    }
  }

  async get(id: string): Promise<Attachment> {
    const stored = await this.getStored(id);
    return publicMetadataSchema.parse(stored);
  }

  async searchText(id: string): Promise<{ attachment: Attachment; text: string } | undefined> {
    const stored = await this.getStored(id);
    if (stored.extractedText === undefined) return undefined;
    return { attachment: publicMetadataSchema.parse(stored), text: stored.extractedText };
  }

  async exportContent(id: string) {
    const attachment = await this.get(id);
    const bytes = await readFile(this.dataPath(id,attachment.name));
    if (bytes.length !== attachment.size || bytes.length > MAX_ATTACHMENT_BYTES) return fail(500,'Attachment failed its stored size check.');
    return {attachment,bytes};
  }

  async markDeleted(id: string) {
    this.validId(id);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeFile(join(this.directory,`${id}.deleted`),'deleted\n',{mode:0o600});
  }

  async resolveForMessage(id: string): Promise<ExtractedAttachment> {
    const stored = await this.getStored(id);
    const attachment = publicMetadataSchema.parse(stored);
    let bytes: Buffer;
    try { bytes = await readFile(this.dataPath(attachment.id,attachment.name)); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fail(404, `Attachment "${attachment.name}" is missing from local storage.`);
      throw error;
    }
    if (bytes.length !== attachment.size || bytes.length > MAX_ATTACHMENT_BYTES) return fail(500, `Attachment "${attachment.name}" failed its stored size check.`);
    const extension = extname(attachment.name).toLowerCase();
    assertFileFormat(extension,attachment.mimeType,bytes);
    if (stored.extractedText !== undefined) return { attachment,text:stored.extractedText };
    if (extension === '.pdf') return { attachment, text:await extractPdfText(bytes) };
    if (extension === '.docx') return { attachment, text:await extractDocxText(bytes) };
    if (textExtensions.has(extension)) return { attachment, text:decodeText(bytes) };
    return { attachment,imagePath:this.dataPath(attachment.id,attachment.name) };
  }
}

export type { ExtractedAttachment };
