import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectedFileUrl, editConnectedFileSchema, fileConnectorSchema, type ConnectedFile } from '../shared/connected-files';
import { connectorReadSchema } from '../shared/connectors';
import { resourceSchema } from '../shared/schema';
import type { Store } from './store';
import type { Connectors } from './connectors';
import { HttpError, requireFound } from './errors';

const headerSchema = z.object({ title: z.string().optional(), name: z.string().optional(), revisionId: z.string().optional(), properties: z.object({ title: z.string().optional() }).optional(), info: z.object({ title: z.string().optional() }).optional() });
const rowSchema = z.object({ values: z.array(z.object({ formattedValue: z.string().optional(), effectiveValue: z.object({ stringValue: z.string().optional(), numberValue: z.number().optional(), boolValue: z.boolean().optional() }).optional() })).default([]) });
const sheetsSchema = z.object({ sheets: z.array(z.object({ properties: z.object({ title: z.string() }), data: z.array(z.object({ startRow:z.number().int().nonnegative().default(0), startColumn:z.number().int().nonnegative().default(0), rowData: z.array(rowSchema).default([]) })).default([]) })).default([]) });
const slidesSchema = z.object({ slides: z.array(z.object({ objectId: z.string(), pageElements: z.array(z.unknown()).default([]) })).default([]) });

function textContent(value: unknown, depth = 0): string {
  if (depth > 40 || value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(item => textContent(item, depth + 1)).join('');
  if ('textRun' in value) {
    const run = z.object({ content: z.string().optional() }).safeParse(value.textRun);
    if (run.success) return run.data.content ?? '';
  }
  if ('plain_text' in value && typeof value.plain_text === 'string') return value.plain_text;
  if ('text' in value && typeof value.text === 'object' && value.text && 'content' in value.text && typeof value.text.content === 'string') return value.text.content;
  return Object.entries(value).filter(([key]) => !['revisionId', 'style', 'textStyle', 'paragraphStyle', 'properties', 'suggestedInsertionIds', 'suggestedDeletionIds'].includes(key)).map(([, item]) => textContent(item, depth + 1)).filter(Boolean).join('\n');
}

export function fileSnapshot(connector: ConnectedFile['connector'], fileId: string, value: unknown, range?: string) {
  const header = headerSchema.parse(value);
  let title = header.title ?? header.name ?? header.properties?.title ?? header.info?.title ?? (connector === 'notion' ? 'Notion page' : 'Connected file');
  let content = textContent(value).slice(0, 150000);
  const sheets: ConnectedFile['sheets'] = [];
  const slides: ConnectedFile['slides'] = [];
  if (connector === 'google-sheets') {
    for (const sheet of sheetsSchema.parse(value).sheets.slice(0, 10)) {
      const rows = sheet.data.flatMap(data => data.rowData).slice(0, 100).map(row => row.values.slice(0, 26).map(cell => cell.formattedValue ?? String(cell.effectiveValue?.stringValue ?? cell.effectiveValue?.numberValue ?? cell.effectiveValue?.boolValue ?? '')));
      sheets.push({ title: sheet.properties.title, startRow:sheet.data[0]?.startRow ?? 0, startColumn:sheet.data[0]?.startColumn ?? 0, rows });
    }
    content = sheets.map(sheet => `${sheet.title}\n${sheet.rows.map(row => row.join('\t')).join('\n')}`).join('\n\n').slice(0, 150000);
  } else if (connector === 'google-slides') {
    for (const slide of slidesSchema.parse(value).slides.slice(0, 100)) slides.push({ id: slide.objectId, text: textContent(slide.pageElements).slice(0, 10000) });
    content = slides.map((slide, index) => `Slide ${index + 1}\n${slide.text}`).join('\n\n').slice(0, 150000);
  } else if (connector === 'google-drive') content = z.object({ description: z.string().optional(), mimeType: z.string().optional() }).parse(value).description ?? 'File linked from Google Drive. Open the matching Docs, Sheets or Slides connector to read document content.';
  else if (connector === 'google-forms') {
    const form = z.object({ items: z.array(z.object({ title: z.string().optional(), description: z.string().optional() })).default([]) }).parse(value);
    content = form.items.map(item => [item.title, item.description].filter(Boolean).join('\n')).join('\n\n');
  }
  title = title.slice(0, 300);
  return { title, content, connectedFile: { connector, fileId, url: connectedFileUrl(connector, fileId), syncedAt: new Date().toISOString(), ...(header.revisionId ? { revision: header.revisionId } : {}), ...(range ? { range } : {}), sheets, slides } satisfies ConnectedFile };
}

export class ConnectedFiles {
  constructor(private readonly store: Store, private readonly connectors: Connectors) {}
  async read(value: unknown) {
    const input = connectorReadSchema.parse(value);
    const result = await this.connectors.read(input);
    const file = fileConnectorSchema.safeParse(input.connector);
    if (input.action !== 'read' || !input.resourceId || !file.success || input.cursor) return result;
    const snapshot = fileSnapshot(file.data, input.resourceId, result.untrustedContent, file.data === 'google-sheets' ? input.query || 'A1:Z100' : undefined);
    const existing = this.store.state.resources.find(item => !item.deletedAt && item.connectedFile?.connector === file.data && item.connectedFile.fileId === input.resourceId);
    const now = new Date().toISOString();
    const resource = resourceSchema.parse({ ...(existing ?? { id: randomUUID(), subjectId: null, topicId: null, kind: 'notes', createdAt: now }), ...snapshot, updatedAt: now });
    if (existing) Object.assign(existing, resource); else this.store.state.resources.push(resource);
    await this.store.save();
    return { ...result, resource };
  }
  async refresh(id: string) {
    const resource = requireFound(this.store.state.resources.find(item => item.id === id && !item.deletedAt), 'Resource');
    const file = resource.connectedFile;
    if (!file) throw new HttpError(400, 'This resource is not a connected file.');
    const result = await this.read({ connector: file.connector, action: 'read', resourceId: file.fileId, query: file.range ?? '' });
    if (!('resource' in result)) throw new HttpError(502, 'The connected file could not be refreshed.');
    return result.resource;
  }
  async edit(value: unknown) {
    const input = editConnectedFileSchema.parse(value);
    await this.connectors.edit(input);
    try { return await this.read({ connector: input.connector, action: 'read', resourceId: input.fileId, query: input.connector === 'google-sheets' ? input.range : '' }); }
    catch { throw new HttpError(502, 'The edit was saved to Google, but the Centre preview could not refresh. Refresh the resource when the connection returns. Do not repeat the edit.'); }
  }
}
