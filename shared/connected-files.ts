import { z } from 'zod';

export const fileConnectorSchema = z.enum(['google-docs', 'google-sheets', 'google-slides', 'google-forms', 'google-drive', 'notion']);
export const editableConnectorSchema = z.enum(['google-docs', 'google-sheets', 'google-slides']);
export const connectedFileSchema = z.object({
  connector: fileConnectorSchema,
  fileId: z.string().min(1).max(300),
  url: z.string().url(),
  syncedAt: z.string().datetime(),
  revision: z.string().optional(),
  range: z.string().max(300).optional(),
  sheets: z.array(z.object({ title: z.string(), startRow:z.number().int().nonnegative().default(0), startColumn:z.number().int().nonnegative().default(0), rows: z.array(z.array(z.string())) })).default([]),
  slides: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
});
export type ConnectedFile = z.infer<typeof connectedFileSchema>;
const editBase = { fileId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200), confirmedByUser: z.literal(true) };
export const editConnectedFileSchema = z.discriminatedUnion('connector', [
  z.object({ ...editBase, connector: z.literal('google-docs'), revision: z.string().min(1).max(300), find: z.string().min(1).max(20000), replacement: z.string().max(20000) }).strict(),
  z.object({ ...editBase, connector: z.literal('google-slides'), revision: z.string().min(1).max(300), find: z.string().min(1).max(20000), replacement: z.string().max(20000) }).strict(),
  z.object({ ...editBase, connector: z.literal('google-sheets'), range: z.string().min(1).max(300), valueInputOption:z.enum(['RAW','USER_ENTERED']).default('RAW'), values: z.array(z.array(z.union([z.string().max(10000), z.number().finite(), z.boolean()])).max(26)).min(1).max(100) }).strict(),
]);
export type ConnectedFileEdit = z.infer<typeof editConnectedFileSchema>;
export function connectedFileUrl(connector: ConnectedFile['connector'], fileId: string) {
  const id = encodeURIComponent(fileId);
  switch (connector) {
    case 'google-docs': return `https://docs.google.com/document/d/${id}/edit`;
    case 'google-sheets': return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case 'google-slides': return `https://docs.google.com/presentation/d/${id}/edit`;
    case 'google-forms': return `https://docs.google.com/forms/d/${id}/edit`;
    case 'google-drive': return `https://drive.google.com/file/d/${id}/view`;
    case 'notion': return `https://www.notion.so/${id.replace(/-/g, '')}`;
  }
}
