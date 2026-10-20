import { z } from 'zod';
import { assignmentSchema, subjectSchema,eventSchema,type StudyEvent } from '../shared/schema';
import { calendarDate,calendarInputSchema,calendarPatchSchema,organatoDeadline } from './calendar';
import type { Store } from './store';
import type { Credentials } from './credentials';
import { HttpError, errorMessage,requireFound } from './errors';

const subject = z.object({ id: z.string(), displayName: z.string(), shortName: z.string().nullable(), colour: z.string(), active: z.boolean() });
const item = z.object({ id: z.string(), displayName: z.string(), kind: z.enum(['work','todo']), subjectId: z.string().nullable(), dueDateLocal: z.string().nullable(), dueAt: z.string().nullable(), workingStatus: z.string(), version: z.number().int().positive(),notesMarkdown:z.string().default(''),calendarEnabled:z.boolean().default(false),completedAt:z.string().nullable().default(null) });
export const createItemSchema = z.object({ kind: z.enum(['work','todo']), displayName: z.string().trim().min(1).max(500), classification: z.enum(['unclassified','assignment','checkpoint','both']).optional(), dueAt: z.iso.datetime().nullable().optional(), dueDateLocal: z.iso.date().nullable().optional(), dueHasExplicitTime: z.boolean().optional(), subjectId: z.string().nullable().optional(), priority: z.enum(['low','medium','high','urgent']).nullable().optional(), calendarEnabled: z.boolean().optional(), remindersEnabled: z.boolean().optional(), notesMarkdown: z.string().max(100000).optional(), calendarNote: z.string().max(20000).optional(), estimatedMinutes: z.number().int().min(1).max(10000).nullable().optional(), recurrenceRule: z.unknown().optional() }).strict();
export const updateItemSchema = createItemSchema.omit({ kind: true, classification: true }).partial().extend({ version: z.number().int().positive(), workingStatus: z.enum(['not_started','in_progress','completed','submitted']).optional(), pinned: z.boolean().optional() }).strict();
export function validOrganatoBase(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new HttpError(400, 'Organato URL must use HTTPS, or localhost HTTP for development.');
  return url.href.replace(/\/$/, '');
}
const mapItem = (value: z.infer<typeof item>) => assignmentSchema.parse({ id: value.id, title: value.displayName, kind: value.kind, subjectId: value.subjectId, dueDate: value.dueDateLocal ?? value.dueAt?.slice(0,10) ?? null, status: value.workingStatus, version: value.version });
export class Organato {
  constructor(private readonly store: Store, private readonly credentials: Credentials) {}
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const key = await this.credentials.get('organatoApiKey');
    if (!key) throw new HttpError(400, 'Add an Organato API key in Settings first.');
    let response: Response;
    try { response = await fetch(`${validOrganatoBase(this.store.state.settings.organatoBaseUrl)}${path}`, { method, headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: 'error' }); }
    catch (error) { if (method !== 'GET') throw new HttpError(502,`The Organato write could not be confirmed: ${errorMessage(error)}. Inspect Organato before retrying.`); throw error; }
    const result: unknown = await response.json();
    if (!response.ok) { const detail = z.object({ error: z.string() }).safeParse(result); throw new HttpError(response.status, `Organato ${response.status}: ${detail.success ? detail.data.error : 'Request rejected. Check API permissions and fields.'}`); }
    return result;
  }
  async sync() {
    try {
      const subjects = z.object({ subjects: z.array(subject) }).parse(await this.request('/subjects')).subjects;
      const assignments = [];
      const records: z.infer<typeof item>[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: '200', archived: 'false' });
        if (cursor) query.set('cursor', cursor);
        const page = z.object({ items: z.array(item), nextCursor: z.string().nullable() }).parse(await this.request(`/items?${query}`));
        records.push(...page.items); assignments.push(...page.items.map(mapItem)); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Organato returned a repeating pagination cursor.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.store.state.subjects = subjects.filter(value => value.active || this.store.state.topics.some(topic => topic.subjectId === value.id)).map(value => subjectSchema.parse({ id: value.id, name: value.displayName, shortName: value.shortName, color: value.colour }));
      this.store.state.assignments = assignments;
      const previousEvents = this.store.state.events;
      this.store.state.events = [...previousEvents.filter(event => !event.organatoId),...records.flatMap(remote => {
        if (remote.kind !== 'todo' || !remote.calendarEnabled) return [];
        const previous = previousEvents.find(event => event.organatoId === remote.id);
        const timeZone = previous?.timeZone ?? this.store.state.settings.timeZone;
        const deadline = calendarDate(remote.dueAt,remote.dueDateLocal,timeZone); if (!deadline) return [];
        return [this.calendarEvent(remote,previous ?? {id:remote.id,title:remote.displayName,...deadline,notes:remote.notesMarkdown,completedAt:remote.completedAt},timeZone)];
      })];
      this.store.state.lastSyncedAt = new Date().toISOString(); this.store.state.syncError = null;
      this.store.state.settings.organatoConnected = true; await this.store.save();
      return this.store.state;
    } catch (error) { this.store.state.syncError = errorMessage(error); await this.store.save(); throw error; }
  }
  async create(input: unknown) { return this.remember(z.object({ item }).parse(await this.request('/items', 'POST', createItemSchema.parse(input))).item); }
  async update(id: string, input: unknown) { return this.remember(z.object({ item }).parse(await this.request(`/items/${encodeURIComponent(id)}`, 'PATCH', updateItemSchema.parse(input))).item); }
  async createEvent(value: unknown) {
    const input = calendarInputSchema.parse(value);
    if (input.subjectId) requireFound(this.store.state.subjects.find(subject => subject.id === input.subjectId),'Subject');
    const timeZone = this.store.state.settings.timeZone;
    const deadline = organatoDeadline(input.date,input.time,timeZone);
    const remote = z.object({item}).parse(await this.request('/items','POST',createItemSchema.parse({kind:'todo',displayName:input.title,subjectId:input.subjectId ?? null,notesMarkdown:input.notes,calendarNote:input.notes,calendarEnabled:true,...deadline}))).item;
    this.requireCalendar(remote);
    const event = this.calendarEvent(remote,{id:remote.id,...input,completedAt:null},timeZone);
    this.store.state.events.push(event); await this.remember(remote); return event;
  }
  async updateEvent(id: string,value: unknown) {
    const event = requireFound(this.store.state.events.find(entry => entry.id === id),'Study session');
    if (!event.organatoId || !event.organatoVersion) throw new HttpError(409,'This older event is stored only in Centre. Create it in Organato before editing or completing it.');
    const patch = calendarPatchSchema.parse(value);
    if (!Object.keys(patch).length) throw new HttpError(400,'Choose a calendar field to update.');
    if (patch.subjectId) requireFound(this.store.state.subjects.find(subject => subject.id === patch.subjectId),'Subject');
    const input = {...event,...patch};
    const deadline = organatoDeadline(input.date,input.time,event.timeZone);
    const update = {version:event.organatoVersion,...(patch.title === undefined ? {} : {displayName:patch.title}),...(patch.subjectId === undefined ? {} : {subjectId:patch.subjectId}),...(patch.notes === undefined ? {} : {notesMarkdown:patch.notes,calendarNote:patch.notes}),...(patch.date === undefined && patch.time === undefined ? {} : deadline),calendarEnabled:true,...(patch.completedAt === undefined ? {} : {workingStatus:patch.completedAt === null ? 'not_started' : 'completed'})};
    const remote = z.object({item}).parse(await this.request(`/items/${encodeURIComponent(event.organatoId)}`,'PATCH',updateItemSchema.parse(update))).item;
    this.requireCalendar(remote);
    const updated = this.calendarEvent(remote,input,event.timeZone);
    Object.assign(event,updated); await this.remember(remote); return event;
  }
  private calendarEvent(remote: z.infer<typeof item>,fallback: Pick<StudyEvent,'id'|'title'|'date'|'notes'|'completedAt'> & {time?:string|null;subjectId?:string|null},timeZone: string) {
    const deadline = calendarDate(remote.dueAt,remote.dueDateLocal,timeZone);
    return eventSchema.parse({...fallback,...deadline,title:remote.displayName,subjectId:remote.subjectId,notes:remote.notesMarkdown,completedAt:remote.workingStatus === 'completed' ? remote.completedAt ?? fallback.completedAt ?? new Date().toISOString() : null,organatoId:remote.id,organatoVersion:remote.version,timeZone});
  }
  private requireCalendar(remote: z.infer<typeof item>) {
    if (remote.kind !== 'todo' || !remote.calendarEnabled || (!remote.dueAt && !remote.dueDateLocal)) throw new HttpError(502,'Organato did not confirm a calendar-enabled todo with a deadline. Inspect Organato before retrying.');
  }
  private async remember(value: z.infer<typeof item>) {
    const mapped = mapItem(value); this.store.state.assignments = [mapped, ...this.store.state.assignments.filter(x => x.id !== mapped.id)];
    this.store.state.events = this.store.state.events.flatMap(event => event.organatoId !== value.id ? [event] : value.calendarEnabled && calendarDate(value.dueAt,value.dueDateLocal,event.timeZone) ? [this.calendarEvent(value,event,event.timeZone)] : []);
    await this.store.save(); return mapped;
  }
}
