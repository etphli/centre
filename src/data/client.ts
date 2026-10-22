import { studyLogSchema, type StudyTags, type StudySegment, type TimerAction } from '../../shared/study-log';
import { connectorsResponseSchema, type ConnectorId, type GoogleConnectorId } from '../../shared/connectors';
import { searchQuerySchema, searchResultsSchema } from '../../shared/search';
import { z } from 'zod';
import { checklistProgressUpdateSchema, diagramPreviewSchema } from '../../shared/checklist-progress';
import { assistantMemorySchema, rememberInputSchema } from '../../shared/schema';
import type { DesktopAction, DesktopActionRequest } from '../../shared/desktop-actions';
import type { LauncherOperation, LauncherList } from '../../shared/desktop-launchers';
import { modelSelectionSchema, type ModelSelection, chatSchema, chatFolderSchema, modelSchema, preferencesSchema, reasoningEffortSchema, topicSchema, resourceSchema, eventSchema, settingsSchema, snapshotSchema, gradeResultSchema, quizDraftSchema, assignmentSchema, attachmentSchema, type Attachment, type Resource, type CreateResource, type PageContext, type StudyEvent, type QuizDraft } from '../../shared/schema';

export interface ExportedFile { filename: string; content: string; mimeType: string }
export interface AttachmentUploadInput { name:string; mimeType:string; data:string }
export interface UpdateStatus { state: string; message: string; version?: string; downloaded?: boolean; configured?: boolean }
type Method = 'GET' | 'POST' | 'PATCH';
export interface DesktopBridge {
  actions: {
    subscribe: (listener: (request: DesktopActionRequest) => void) => () => void;
    ready: () => Promise<void>;
    acknowledge: (id: string) => Promise<void>;
  };
  launchers: {
    list: () => Promise<LauncherList>;
    change: (action: DesktopAction, operation: LauncherOperation) => Promise<LauncherList>;
  };
  request: (method: Method, path: string, body?: unknown) => Promise<unknown>;
  chooseFiles: () => Promise<AttachmentUploadInput[]>;
  openDiagram: (input:{id:string;theme:string}) => Promise<unknown>;
  openExternal: (url: string) => Promise<unknown>;
  saveFile: (file: ExportedFile) => Promise<unknown>;
  printPaper: (paper: { title: string; latex: string; html?: string }) => Promise<unknown>;
  updates: { check: () => Promise<UpdateStatus>; install: () => Promise<UpdateStatus>; status: () => Promise<UpdateStatus>; configure: (input: { token: string }) => Promise<UpdateStatus> };
}
declare global { interface Window { centre?: DesktopBridge } }

let stateEtag: string | null = null;

async function request<T>(method: Method, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let value: unknown;
  let nextStateEtag: string | null = null;
  const stateRequest = method === 'GET' && (path === '/state' || path === '/state/poll');
  if (window.centre) value = await window.centre.request(method, path, body);
  else {
    const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(path === '/state/poll' && stateEtag ? { 'If-None-Match':stateEtag } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (path === '/state/poll' && response.status === 304) return schema.parse(null);
    if (stateRequest) nextStateEtag = response.headers.get('etag');
    value = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(value);
      throw new Error(error.success ? error.data.error : `Centre returned ${response.status}.`);
    }
  }
  const failure = z.object({ error: z.string() }).safeParse(value);
  if (failure.success) throw new Error(failure.data.error);
  const result = schema.parse(value);
  if (stateRequest && !window.centre && (path === '/state/poll' || !stateEtag)) stateEtag = nextStateEtag;
  return result;
}
const okSchema = z.object({ ok: z.literal(true) });
const exportSchema = z.object({ filename: z.string(), content: z.string(), mimeType: z.string() });
export const api = {
  studyLog: () => request('GET', '/study-log', studyLogSchema),
  createStudy: (input: StudyTags & {id:string;segments:StudySegment[]}) => request('POST', '/study-log/sessions', studyLogSchema, input),
  editStudy: (id:string,input:StudyTags & {expectedRevision:number;segments:StudySegment[]}) => request('PATCH', `/study-log/sessions/${encodeURIComponent(id)}`, studyLogSchema, input),
  deleteStudy: (id:string,expectedRevision:number) => request('POST', `/study-log/sessions/${encodeURIComponent(id)}/delete`, studyLogSchema, {expectedRevision}),
  startStudy: (input:StudyTags & {id:string}) => request('POST', '/study-log/timer/start', studyLogSchema, input),
  timerStudy: (id:string,action:TimerAction,expectedRevision:number,activity = false) => request('POST', `/study-log/timer/${encodeURIComponent(id)}/${action}`, studyLogSchema, {expectedRevision,activity}),
  saveStudyGoal: (input:{id:string;weekStart:string;timeZone:string;targetMinutes:number;expectedRevision?:number}) => request('POST', '/study-log/goals', studyLogSchema, input),
  state: () => request('GET', '/state', snapshotSchema),
  search: (query: string) => request('GET', `/search?q=${encodeURIComponent(searchQuerySchema.parse(query))}`, searchResultsSchema),
  updateMemory: (id:string, content:string) => request('PATCH', `/assistant-memories/${encodeURIComponent(id)}`, assistantMemorySchema, rememberInputSchema.omit({ key:true }).parse({ content })),
  forgetMemory: (id:string) => request('POST', `/assistant-memories/${encodeURIComponent(id)}/forget`, okSchema, {}),
  pollState: () => request('GET', '/state/poll', snapshotSchema.nullable()),
  models: () => request('GET', '/models', z.object({ models: z.array(modelSchema) })),
  createChat: (modelSelection:ModelSelection|null = null) => request('POST', '/chats', chatSchema, {modelSelection}),
  selectChatModel: (id:string,selection:ModelSelection) => request('PATCH',`/chats/${encodeURIComponent(id)}/model`,chatSchema,modelSelectionSchema.parse(selection)),
  organizeChat: (chatId: string, input: { pinned?: boolean; folderId?: string | null; beforeChatId?: string | null }) => request('PATCH', `/chats/${encodeURIComponent(chatId)}/organize`, chatSchema, input),
  sendMessage: (chatId: string, content: string, context: PageContext, attachmentIds: string[] = [], resourceRequest?:CreateResource, messageId?:string) => request('POST', `/chats/${encodeURIComponent(chatId)}/messages`, chatSchema, { content, context, attachmentIds, resourceRequest,messageId }),
  branchChat: (chatId:string,input:{operation:'continue'|'edit'|'regenerate';messageId:string;content?:string}) => request('POST',`/chats/${encodeURIComponent(chatId)}/branch`,chatSchema,input),
  retryMessage: (chatId:string,messageId:string) => request('POST',`/chats/${encodeURIComponent(chatId)}/retry`,chatSchema,{messageId}),
  uploadAttachment: (file: AttachmentUploadInput): Promise<Attachment> => request('POST','/attachments',attachmentSchema,file),
  getAttachment: (id: string): Promise<Attachment> => request('GET',`/attachments/${encodeURIComponent(id)}`,attachmentSchema),
  answerQuestion: (id:string,answers:Record<string,string>) => request('POST',`/questions/${encodeURIComponent(id)}/answer`,okSchema,{answers}),
  cancelChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/cancel`, okSchema, {}),
  archiveChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/archive`, okSchema, {}),
  restoreChat: (chatId: string) => request('POST', `/chats/${encodeURIComponent(chatId)}/restore`, chatSchema, {}),
  createChatFolder: (name: string) => request('POST', '/chat-folders', chatFolderSchema, { name }),
  updateChatFolder: (folderId: string, input: { name?: string; collapsed?: boolean; beforeFolderId?: string | null }) => request('PATCH', `/chat-folders/${encodeURIComponent(folderId)}`, chatFolderSchema, input),
  deleteChatFolder: (folderId: string) => request('POST', `/chat-folders/${encodeURIComponent(folderId)}/remove`, okSchema, {}),
  createTopic: (subjectId: string, name: string) => request('POST', '/topics', topicSchema, { subjectId, name }),
  generateResource: (input: CreateResource) => request('POST', '/resources/generate', resourceSchema, input),
  deleteResource: (id:string) => request('POST',`/resources/${encodeURIComponent(id)}/archive`,okSchema,{}),
  restoreResource: (id:string) => request('POST',`/resources/${encodeURIComponent(id)}/restore`,okSchema,{}),
  moveResource: (id:string,location:{subjectId:string|null;topicId:string|null}) => request('PATCH',`/resources/${encodeURIComponent(id)}/location`,resourceSchema,location),
  saveQuizDraft: (resourceId:string,input:{id:string;expectedRevision:number|null;answers:Record<string,string>;currentQuestion:number}):Promise<QuizDraft> => request('PATCH',`/resources/${encodeURIComponent(resourceId)}/practice-draft`,quizDraftSchema,input),
  startOverQuizDraft: (resourceId:string,input:{id:string;expectedRevision:number}) => request('POST',`/resources/${encodeURIComponent(resourceId)}/practice-draft/start-over`,okSchema,input),
  exportResource: (id: string) => request('GET', `/resources/${encodeURIComponent(id)}/export`, exportSchema),
  refreshConnectedFile: (id:string) => request('POST', `/resources/${encodeURIComponent(id)}/refresh`,resourceSchema,{}),
  previewResource: (id: string) => request('GET', `/resources/${encodeURIComponent(id)}/preview`, diagramPreviewSchema),
  saveChecklistProgress: (id:string,documentRevision:string,itemId:string,checked:boolean) => request('POST',`/resources/${encodeURIComponent(id)}/checklist-progress`,okSchema,checklistProgressUpdateSchema.parse({documentRevision,itemId,checked})),
  saveFeedback: (id: string, notes: string, questionIds: string[] = [], confident = false) => request('POST', `/resources/${encodeURIComponent(id)}/feedback`, okSchema, { notes, questionIds, confident }),
  gradeQuiz: (resourceId: string, answers: Record<string, string>, submission?:{draftId:string;expectedDraftRevision:number}) => request('POST', '/quiz/grade', gradeResultSchema, { resourceId, answers, ...(submission ?? {}) }),
  createEvent: (input: Pick<StudyEvent, 'title' | 'date'> & Partial<Pick<StudyEvent, 'time' | 'plannedDurationMinutes' | 'subjectId' | 'notes'>>) => request('POST', '/events', eventSchema, input),
  updateEvent: (id:string,input:Partial<Pick<StudyEvent,'title'|'date'|'time'|'plannedDurationMinutes'|'subjectId'|'notes'>> & {expectedRevision:number}) => request('PATCH',`/events/${encodeURIComponent(id)}`,eventSchema,input),
  completeEvent: (id: string, completed: boolean, expectedRevision?:number) => request('PATCH', `/events/${encodeURIComponent(id)}`, eventSchema, { completedAt: completed ? new Date().toISOString() : null,...(expectedRevision === undefined ? {} : {expectedRevision}) }),
  archiveEvent: (id:string,expectedRevision:number) => request('POST',`/events/${encodeURIComponent(id)}/archive`,eventSchema,{expectedRevision}),
  resolveMemory: (id: string) => request('POST', `/memories/${encodeURIComponent(id)}/resolve`, okSchema, {}),
  syncOrganato: () => request('POST', '/organato/sync', snapshotSchema, {}),
  createOrganatoItem: (input: unknown) => request('POST', '/organato/items', assignmentSchema, input),
  connectors: () => request('GET', '/connectors', connectorsResponseSchema),
  connectGoogle: async (id: GoogleConnectorId, editable = false) => { const result = await request('POST', '/connectors/google/start', z.object({url:z.string().url()}), {id,editable}); await openExternal(result.url); return result; },
  connectNotion: (token:string) => request('POST', '/connectors/notion', okSchema, {token}),
  disconnectConnector: (id:ConnectorId) => request('POST', '/connectors/disconnect', okSchema, {id}),
  cancelConnector: () => request('POST', '/connectors/cancel', okSchema, {}),
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
