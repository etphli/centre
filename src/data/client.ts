import { z } from 'zod';
import { chatSchema, chatFolderSchema, modelSchema, preferencesSchema, reasoningEffortSchema, topicSchema, resourceSchema, eventSchema, settingsSchema, snapshotSchema, gradeResultSchema, assignmentSchema, attachmentSchema, type Attachment, type Resource, type CreateResource, type PageContext, type StudyEvent } from '../../shared/schema';

export interface ExportedFile { filename: string; content: string; mimeType: string }
export interface AttachmentUploadInput { name:string; mimeType:string; data:string }
export interface UpdateStatus { state: string; message: string; version?: string; downloaded?: boolean; configured?: boolean }
type Method = 'GET' | 'POST' | 'PATCH';
export interface DesktopBridge {
  request: (method: Method, path: string, body?: unknown) => Promise<unknown>;
  chooseFiles: () => Promise<AttachmentUploadInput[]>;
  openDiagram: (input:{id:string;theme:string}) => Promise<unknown>;
  openExternal: (url: string) => Promise<unknown>;
  saveFile: (file: ExportedFile) => Promise<unknown>;
  printPaper: (paper: { title: string; latex: string; html?: string }) => Promise<unknown>;
  updates: { check: () => Promise<UpdateStatus>; install: () => Promise<UpdateStatus>; status: () => Promise<UpdateStatus>; configure: (input: { token: string }) => Promise<UpdateStatus> };
}
declare global { interface Window { centre?: DesktopBridge } }

async function request<T>(method: Method, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let value: unknown;
  if (window.centre) value = await window.centre.request(method, path, body);
  else {
    const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    value = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(value);
      throw new Error(error.success ? error.data.error : `Centre returned ${response.status}.`);
    }
  }
  const failure = z.object({ error: z.string() }).safeParse(value);
  if (failure.success) throw new Error(failure.data.error);
  return schema.parse(value);
}
const okSchema = z.object({ ok: z.literal(true) });
const exportSchema = z.object({ filename: z.string(), content: z.string(), mimeType: z.string() });
export const api = {
  state: () => request('GET', '/state', snapshotSchema),
  models: () => request('GET', '/models', z.object({ models: z.array(modelSchema) })),
  createChat: () => request('POST', '/chats', chatSchema, {}),
  organizeChat: (chatId: string, input: { pinned?: boolean; folderId?: string | null; beforeChatId?: string | null }) => request('PATCH', `/chats/${encodeURIComponent(chatId)}/organize`, chatSchema, input),
  sendMessage: (chatId: string, content: string, context: PageContext, attachmentIds: string[] = []) => request('POST', `/chats/${encodeURIComponent(chatId)}/messages`, chatSchema, { content, context, attachmentIds }),
  uploadAttachment: (file: AttachmentUploadInput): Promise<Attachment> => request('POST','/attachments',attachmentSchema,file),
  getAttachment: (id: string): Promise<Attachment> => request('GET',`/attachments/${encodeURIComponent(id)}`,attachmentSchema),
  cancelChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/cancel`, okSchema, {}),
  archiveChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/archive`, okSchema, {}),
  restoreChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/restore`, chatSchema, {}),
  createChatFolder: (name: string) => request('POST', '/chat-folders', chatFolderSchema, { name }),
  updateChatFolder: (folderId: string, input: { name?: string; collapsed?: boolean; beforeFolderId?: string | null }) => request('PATCH', `/chat-folders/${encodeURIComponent(folderId)}`, chatFolderSchema, input),
  deleteChatFolder: (folderId: string) => request('POST', `/chat-folders/${encodeURIComponent(folderId)}/remove`, okSchema, {}),
  createTopic: (subjectId: string, name: string) => request('POST', '/topics', topicSchema, { subjectId, name }),
  generateResource: (input: CreateResource) => request('POST', '/resources/generate', resourceSchema, input),
  moveResource: (id:string,location:{subjectId:string;topicId:string}) => request('PATCH',`/resources/${encodeURIComponent(id)}/location`,resourceSchema,location),
  exportResource: (id: string) => request('GET', `/resources/${encodeURIComponent(id)}/export`, exportSchema),
  previewResource: (id: string) => request('GET', `/resources/${encodeURIComponent(id)}/preview`, z.object({ url: z.string().url() })),
  saveFeedback: (id: string, notes: string, questionIds: string[] = [], confident = false) => request('POST', `/resources/${encodeURIComponent(id)}/feedback`, okSchema, { notes, questionIds, confident }),
  gradeQuiz: (resourceId: string, answers: Record<string, string>) => request('POST', '/quiz/grade', gradeResultSchema, { resourceId, answers }),
  createEvent: (input: Pick<StudyEvent, 'title' | 'date'> & Partial<Pick<StudyEvent, 'time' | 'subjectId' | 'notes'>>) => request('POST', '/events', eventSchema, input),
  completeEvent: (id: string, completed: boolean) => request('PATCH', `/events/${encodeURIComponent(id)}`, eventSchema, { completedAt: completed ? new Date().toISOString() : null }),
  resolveMemory: (id: string) => request('POST', `/memories/${encodeURIComponent(id)}/resolve`, okSchema, {}),
  syncOrganato: () => request('POST', '/organato/sync', snapshotSchema, {}),
  createOrganatoItem: (input: unknown) => request('POST', '/organato/items', assignmentSchema, input),
  skills: () => request('GET', '/skills', z.object({ skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), source: z.string() })) })),
  saveSettings: (patch: Partial<z.infer<typeof preferencesSchema>> & { organatoApiKey?: string; organatoBaseUrl?: string; googleClientId?: string; googleClientSecret?: string; chatModel?: string; gradingModel?: string; gradingReasoningEffort?: z.infer<typeof reasoningEffortSchema>; reasoningEffort?: z.infer<typeof reasoningEffortSchema> }) => request('PATCH', '/settings', settingsSchema, patch),
  googleSignIn: async () => { const result = await request('POST', '/auth/google/start', z.object({ url: z.string() }), {}); await openExternal(result.url); return result; },
  googleSignOut: () => request('POST', '/auth/google/logout', okSchema, {}),
  codexSignIn: async () => { const result = await request('POST', '/auth/codex/start', z.object({ url: z.string().optional(), message: z.string() }), {}); if (result.url) await openExternal(result.url); return result; },
};
export async function chooseAttachmentFiles(): Promise<AttachmentUploadInput[]> {
  if (!window.centre) return [];
  const result: unknown = await window.centre.chooseFiles();
  return z.array(z.object({ name:z.string().min(1).max(200),mimeType:z.string().max(200),data:z.string().max(28_000_000) }).strict()).max(5).parse(result);
}
export async function openExternal(url: string): Promise<void> {
  if (window.centre) { await window.centre.openExternal(url); return; }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('This link cannot be opened.');
  window.open(url, '_blank', 'noopener,noreferrer');
}
export async function downloadFile(file: ExportedFile): Promise<void> {
  if (window.centre) { await window.centre.saveFile(file); return; }
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function printPaper(resource: Resource): Promise<void> {
  const file = await api.exportResource(resource.id);
  if (window.centre) { await window.centre.printPaper({ title: resource.title, latex: file.content }); return; }
  await downloadFile({ filename: `${resource.title.replace(/[^a-z0-9 -]/gi, '')}.tex`, content: file.content, mimeType: 'application/x-latex' });
}
const desktopOnly = async (): Promise<UpdateStatus> => ({ state: 'unavailable', message: 'Updates are available in the Centre desktop app.' });
export const updates = {
  status: () => window.centre ? window.centre.updates.status() : desktopOnly(),
  check: () => window.centre ? window.centre.updates.check() : desktopOnly(),
  install: () => window.centre ? window.centre.updates.install() : desktopOnly(),
  configure: (input: { token: string }) => window.centre ? window.centre.updates.configure(input) : desktopOnly(),
};

export async function openDiagramFile(id:string,theme:string):Promise<void> {
  if (window.centre) { await window.centre.openDiagram({id,theme});return; }
  const {url} = await api.previewResource(id);
  const target = new URL(url);target.searchParams.set('theme',theme);
  window.open(target.href,'_blank','noopener,noreferrer');
}
