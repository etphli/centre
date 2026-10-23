import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachments';
import { Store } from './store';
import { snapshotSchema } from '../shared/schema';
import { projectMessageForSync } from '../shared/chat-sync';
import { HttpError } from './errors';
import { createService } from './index';

function pdfWithText(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf,'utf8');
}

const upload = (name: string, bytes: Buffer, mimeType = '') => ({ name,mimeType,data:bytes.toString('base64') });
const uploadError = async (store: AttachmentStore, input: unknown, status: number) => {
  await assert.rejects(store.upload(input),error => (error instanceof HttpError && error.status === status) || (status === 400 && error instanceof ZodError));
};

test('text, PDF, and DOCX attachments extract bounded content and persist private bytes with public metadata',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-attachments-test-'));
  const store = new AttachmentStore(directory);
  try {
    const textBytes = Buffer.from('Revise quadratic equations.','utf8');
    const text = await store.upload(upload('revision.md',textBytes,'text/markdown'));
    assert.deepEqual(await store.get(text.id),text);
    assert.deepEqual(Object.keys(await store.get(text.id)).sort(),['id','mimeType','name','size']);
    assert.equal((await store.resolveForMessage(text.id)).text,'Revise quadratic equations.');

    const pdf = await store.upload(upload('worksheet.pdf',pdfWithText('PDF attachment text'),'application/pdf'));
    assert.match((await store.resolveForMessage(pdf.id)).text ?? '',/PDF attachment text/);

    const docxBytes = await readFile(new URL('../node_modules/mammoth/test/test-data/single-paragraph.docx',import.meta.url));
    const docx = await store.upload(upload('notes.docx',docxBytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    assert.match((await store.resolveForMessage(docx.id)).text ?? '',/Walking on imported air/);

    const restartedStore = new AttachmentStore(directory);
    assert.deepEqual(await restartedStore.get(text.id),text);
    assert.equal((await restartedStore.resolveForMessage(text.id)).text,'Revise quadratic equations.');
    assert.equal((await readFile(join(directory,'attachments',`${text.id}.md`))).toString('utf8'),'Revise quadratic equations.');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('image attachments retain a private local input path and reject invalid signatures',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-image-attachment-test-'));
  const store = new AttachmentStore(directory);
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kBs0AAAAASUVORK5CYII=','base64');
    const image = await store.upload(upload('diagram.png',png,'image/png'));
    const resolved = await store.resolveForMessage(image.id);
    assert.equal(resolved.imagePath,join(directory,'attachments',`${image.id}.png`));
    assert.equal((await readFile(resolved.imagePath ?? '')).toString('base64'),png.toString('base64'));
    assert.equal('imagePath' in await store.get(image.id),false);
    await uploadError(store,upload('broken.png',Buffer.from('not png'),'image/png'),400);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('uploads reject traversal names, corrupt encodings, unsupported formats, and oversized text or document expansion',async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-invalid-attachment-test-'));
  const store = new AttachmentStore(directory);
  try {
    await uploadError(store,upload('../outside.txt',Buffer.from('text'),'text/plain'),400);
    await uploadError(store,{ name:'bad.txt',mimeType:'text/plain',data:'****' },400);
    await uploadError(store,upload('archive.zip',Buffer.from('PK\x03\x04'),'application/zip'),415);
    await uploadError(store,upload('large.txt',Buffer.alloc(MAX_ATTACHMENT_BYTES + 1,65),'text/plain'),413);
    await uploadError(store,upload('too-long.txt',Buffer.alloc(200_001,65),'text/plain'),413);

    const docxBytes = Buffer.from(await readFile(new URL('../node_modules/mammoth/test/test-data/single-paragraph.docx',import.meta.url)));
    const documentName = 'word/document.xml';
    let centralOffset = -1;
    for (let offset = 0; offset + 46 < docxBytes.length; offset++) {
      if (docxBytes.readUInt32LE(offset) !== 0x02014b50) continue;
      const nameLength = docxBytes.readUInt16LE(offset + 28);
      if (docxBytes.toString('utf8',offset + 46,offset + 46 + nameLength) === documentName) { centralOffset = offset; break; }
    }
    assert.ok(centralOffset >= 0);
    docxBytes.writeUInt32LE(10 * 1024 * 1024 + 1,centralOffset + 24);
    await uploadError(store,upload('zipbomb.docx',docxBytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),413);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

for (const count of [1,6,25]) test(`attachment API persists and syncs ${count} files after the AI service is unavailable`,async () => {
  const directory = await mkdtemp(join(tmpdir(),'centre-attachment-api-test-'));
  const originalCodexBinary = process.env.CENTRE_CODEX_BIN;
  process.env.CENTRE_CODEX_BIN = join(directory,'missing-codex');
  const service = await createService({ dataDir:directory });
  const request = async (path: string,method = 'GET',body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`,{ method,headers:{ Authorization:`Bearer ${service.token}`,...(body === undefined ? {} : { 'Content-Type':'application/json' }) },...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    return { status:response.status,body:await response.json() };
  };
  try {
    const uploaded = await request('/api/attachments','POST',upload('lesson.txt',Buffer.from('Read this as study material.'),'text/plain'));
    assert.equal(uploaded.status,200);
    assert.deepEqual(Object.keys(uploaded.body).sort(),['id','mimeType','name','size']);
    assert.equal(uploaded.body.name,'lesson.txt');
    assert.equal((await request(`/api/attachments/${uploaded.body.id}`)).status,200);
    assert.equal((await request(`/api/attachments/${uploaded.body.id}`)).body.name,'lesson.txt');

    const attachmentIds:string[] = [uploaded.body.id];
    for (let index = 1; index < count; index++) {
      const next = await request('/api/attachments','POST',upload(`lesson-${index}.txt`,Buffer.from(`Study material ${index}.`),'text/plain'));
      assert.equal(next.status,200);
      attachmentIds.push(next.body.id);
    }
    const chat = await request('/api/chats','POST',{});
    const path = `/api/chats/${chat.body.id}/messages`;
    assert.equal((await request(path,'POST',{content:'',context:{page:'chat'},attachmentIds:[...attachmentIds,attachmentIds[0]]})).status,400);
    const attempted = await request(path,'POST',{ content:'',context:{ page:'chat' },attachmentIds });
    assert.equal(attempted.status,500);
    const persisted = await request('/api/state');
    assert.equal(persisted.status,200);
    assert.equal(persisted.body.chats[0].messages[0].content,'');
    snapshotSchema.parse(persisted.body);
    assert.deepEqual(persisted.body.chats[0].messages[0].attachmentIds,attachmentIds);
    assert.deepEqual(persisted.body.chats[0].activity,[]);
    const reopened = await Store.open(directory);
    const message = reopened.state.chats[0]?.messages[0];
    assert.ok(message);
    assert.deepEqual(message.attachmentIds,attachmentIds);
    assert.deepEqual(projectMessageForSync(message,chat.body.id).attachmentIds,attachmentIds);
  } finally {
    await service.close(); await rm(directory,{recursive:true,force:true});
    if (originalCodexBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalCodexBinary;
  }
});
