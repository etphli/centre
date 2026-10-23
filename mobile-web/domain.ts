import { z } from 'zod';
import { preferencesSchema, resourceSchema, memorySchema, calendarEventSchema, eventSchema, assignmentSchema, subjectSchema, type Resource } from '../shared/schema';
import { quizDraftSchema, attemptSchema } from '../shared/practice';
import { syncedChatSchema, syncedMessageSchema } from '../shared/chat-sync';
import { closeRunning, recoverStudySession, studySessionSchema, weeklyStudyGoalSchema, localStudyInstant, type StudySession, studyTimeZoneSchema } from '../shared/study-log';
import type { MobileEntity } from './data/store';

export function records<T>(entities: readonly MobileEntity[], kind: string, schema: z.ZodType<T>): T[] {
  return entities.flatMap(record => {
    if (record.kind !== kind || record.deleted || !record.data) return [];
    const parsed = schema.safeParse(record.data);
    return parsed.success ? [parsed.data] : [];
  });
}
export function library(entities: readonly MobileEntity[]) {
  return {
    resources: records(entities, 'resource', resourceSchema).filter(item => !item.deletedAt),
    sessions: records(entities, 'studySession', studySessionSchema).filter(item => !item.deletedAt),
    goals: records(entities, 'studyGoal', weeklyStudyGoalSchema).filter(item => !item.deletedAt),
    drafts: records(entities, 'practice.draft', quizDraftSchema).filter(item => !item.deletedAt),
    attempts: records(entities, 'practice.attempt', attemptSchema),
    reviews: records(entities, 'reviewMemory', memorySchema),
    chats: records(entities, 'chat', syncedChatSchema).filter(item => !item.deletedAt),
    messages: records(entities, 'message', syncedMessageSchema),
    events: records(entities, 'calendarEvent', calendarEventSchema).filter(item => !item.deletedAt),
    preferences: records(entities, 'preferences', preferencesSchema)[0] ?? preferencesSchema.parse({}),
  };
}
export const organatoSnapshotSchema = z.object({ subjects: z.array(subjectSchema), events: z.array(eventSchema.extend({timeZone:studyTimeZoneSchema})), assignments:z.array(assignmentSchema).default([]), fetchedAt: z.string() });
export type OrganatoSnapshot = z.infer<typeof organatoSnapshotSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export function timeLabel(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
export function dateLabel(value: string, timeZone?: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(timeZone ? {timeZone} : {}) }).format(date) : 'Unknown date';
}
export function localDate(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}
export function manualSession(input: { title: string; date: string; time: string; minutes: number; subjectId: string | null; timeZone: string }, now: number): StudySession {
  const start = localStudyInstant(input.date, input.time, input.timeZone);
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) throw new Error('Use a duration from 1 to 1,440 minutes.');
  const end = new Date(Date.parse(start) + input.minutes * 60_000).toISOString();
  if (Date.parse(end) > now + 60_000) throw new Error('Log study you have already completed.');
  const stamp = new Date(now).toISOString();
  return studySessionSchema.parse({ schemaVersion:1,id:crypto.randomUUID(),revision:1,createdAt:stamp,updatedAt:stamp,deletedAt:null,title:input.title,notes:'',subjectId:input.subjectId,taskId:null,timeZone:input.timeZone,source:'manual',segments:[{start,end}],state:{kind:'completed'} });
}
export function newTimer(title: string, subjectId: string | null, timeZone: string, now: number, targetMinutes?: number): StudySession {
  const stamp = new Date(now).toISOString();
  return studySessionSchema.parse({schemaVersion:1,id:crypto.randomUUID(),revision:1,createdAt:stamp,updatedAt:stamp,deletedAt:null,title,notes:'',subjectId,taskId:null,timeZone,source:'timer',...(targetMinutes===undefined?{}:{targetMinutes}),segments:[],state:{kind:'running',since:stamp,checkpointAt:stamp,lastActivityAt:stamp,confirmedAt:stamp}});
}
export function timerChange(session: StudySession, action: 'heartbeat'|'pause'|'resume'|'finish'|'confirm', now: number, lastActivity = now): StudySession {
  const recovered = recoverStudySession(session, now);
  const stamp = new Date(now).toISOString();
  if (recovered !== session && action !== 'finish') return studySessionSchema.parse(recovered);
  let next = recovered;
  if (action === 'resume') {
    if (next.state.kind !== 'paused') throw new Error('Only a paused timer can resume.');
    next = {...next,state:{kind:'running',since:stamp,checkpointAt:stamp,lastActivityAt:stamp,confirmedAt:stamp}};
  } else if (action === 'finish') next = closeRunning(next, now, {kind:'completed'});
  else if (action === 'pause') next = closeRunning(next, now, {kind:'paused',reason:'user'});
  else if (next.state.kind === 'running') next = {...next,state:{...next.state,checkpointAt:stamp,lastActivityAt:new Date(Math.min(now,Math.max(Date.parse(next.state.lastActivityAt),lastActivity))).toISOString(),...(action === 'confirm' ? {confirmedAt:stamp} : {})}};
  else return next;
  return studySessionSchema.parse({...next,revision:session.revision+1,updatedAt:stamp});
}
export function freshDraft(resource: Resource, now: number) {
  const stamp = new Date(now).toISOString();
  return quizDraftSchema.parse({schemaVersion:1,id:crypto.randomUUID(),revision:1,resourceId:resource.id,answers:{},currentQuestion:0,createdAt:stamp,updatedAt:stamp,deletedAt:null});
}
export function pairingCode(input: string, origin: string): string {
  let code = input.trim();
  if (code.startsWith('https://') || code.startsWith('http://')) {
    const url = new URL(code);
    if (url.origin !== origin || url.pathname !== '/pair' || url.search) throw new Error('Use an account code from this Centre Cloud.');
    code = new URLSearchParams(url.hash.slice(1)).get('code') ?? '';
  }
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(code)) throw new Error('Paste the one-time account code from Centre on your Mac.');
  return code;
}

export function clockLabel(ms:number):string {const seconds=Math.ceil(Math.max(0,ms)/1000),minutes=Math.floor(seconds/60);return `${minutes}:${String(seconds%60).padStart(2,'0')}`;}
