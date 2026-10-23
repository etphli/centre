import { z } from 'zod';
import { chatSchema, messageSchema, resourceSchema, topicSchema, chatFolderSchema, memorySchema, assistantMemorySchema, preferencesSchema, calendarEventSchema, type Snapshot } from '../shared/schema';
import { attemptSchema, quizDraftSchema, learningNeedSchema } from '../shared/practice';
import { studyLogToCloudRecords, applyStudyCloudRecord } from '../shared/study-log-sync';
import { interactiveResourceProgressSchema } from '../shared/checklist-progress';
import { projectChatForSync, projectMessageForSync } from '../shared/chat-sync';
import type { CloudRecord } from '../shared/cloud';

export type ProjectedRecord = Pick<CloudRecord, 'kind' | 'id' | 'deleted' | 'data'>;
export const recordKey = (value: {kind:string;id:string}) => `${value.kind}:${value.id}`;
function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const sameRecord = (a: ProjectedRecord | undefined, b: ProjectedRecord | undefined) =>
  a?.deleted === b?.deleted && canonical(a?.data) === canonical(b?.data);

export const projectedKinds = new Set(['topic','resource','chat','message','chatFolder','attempt','reviewMemory','learnerMemory','preferences','studySession','studyGoal','interactiveProgress','practice.draft','practice.attempt','practice.learningNeed','calendarEvent']);

/** The allowlist is intentional. A Snapshot is never a cloud upload payload. */
export function projectStudyData(state: Snapshot, shadow: Record<string, CloudRecord> = {}): ProjectedRecord[] {
  const rows: ProjectedRecord[] = [];
  const add = (kind: string, value: {id:string;deletedAt?:string|null} & Record<string,unknown>) => {
    const deleted = Boolean(value.deletedAt);
    rows.push({kind,id:value.id,deleted,data:deleted ? null : value});
  };
  for (const topic of state.topics) add('topic', topic);
  for (const resource of state.resources) {
    const { id,subjectId,topicId,title,kind,createdAt,updatedAt,content,questions,practiceFocus,questionTypes,testLength,durationMinutes,completedAt,deletedAt } = resource;
    add('resource', { id,subjectId,topicId,title,kind,createdAt,updatedAt,content,questions,practiceFocus,questionTypes,testLength,durationMinutes,completedAt,deletedAt:deletedAt ?? null });
  }
  for (const chat of state.chats) {
    // Archive keeps ancestry and retained associations available to active descendants.
    rows.push({kind:'chat',id:chat.id,deleted:false,data:projectChatForSync(chat)});
    for (const message of chat.messages) {
      add('message', projectMessageForSync(message,chat.id));
    }
  }
  for (const folder of state.chatFolders) add('chatFolder',folder);
  for (const attempt of state.attempts) add(attempt.sourceDraftId ? 'practice.attempt' : 'attempt',attempt);
  for (const memory of state.memories) add('reviewMemory',memory);
  for (const memory of state.assistantMemories) add('learnerMemory',memory);
  rows.push({kind:'preferences',id:'preferences',deleted:false,data:preferencesSchema.parse(state.settings)});
  for (const row of studyLogToCloudRecords(state.studyLog)) rows.push({...row,data:row.deleted ? null : row.data});
  for (const value of state.practiceDrafts) add('practice.draft',value);
  for (const value of state.learningNeeds) add('practice.learningNeed',value);
  for (const value of state.interactiveResourceProgress) add('interactiveProgress',value);
  for (const value of state.events) { const event = calendarEventSchema.safeParse(value); if (event.success) add('calendarEvent',event.data); }
  return rows;
}

function replace<T extends {id:string}>(values:T[], id:string, value:T|null):T[] {
  return value ? [...values.filter(item => item.id !== id),value] : values.filter(item => item.id !== id);
}

/** Applies one accepted transport record to the latest local state. No ancestry cascade. */
export function applyStudyRecord(state: Snapshot, record: CloudRecord, now = Date.now(), ordering:Record<string,CloudRecord> = {}) {
  const value = record.deleted ? null : record.data;
  switch (record.kind) {
    case 'topic': state.topics = replace(state.topics,record.id,value === null ? null : topicSchema.parse(value)); break;
    case 'resource': {
      const existing = state.resources.find(item => item.id === record.id);
      if (value === null) { if (existing) existing.deletedAt = record.updatedAt; }
      else if (existing) Object.assign(existing,resourceSchema.parse(value));
      else state.resources = replace(state.resources,record.id,resourceSchema.parse(value));
      break;
    }
    case 'chat': {
      const existing = state.chats.find(item => item.id === record.id);
      if (value === null) { if (existing) existing.deletedAt = record.updatedAt; }
      else {
        const parsed = chatSchema.omit({messages:true}).parse(value);
        if (existing) Object.assign(existing,parsed,{codexThreadId:existing.codexThreadId,activity:existing.activity,responseError:existing.responseError});
        else state.chats = replace(state.chats,record.id,chatSchema.parse({...parsed,messages:[]}));
      }
      break;
    }
    case 'message': {
      const incoming = value === null ? null : z.object({chatId:z.string()}).parse(value);
      const chat = incoming ? state.chats.find(item => item.id === incoming.chatId) : state.chats.find(item => item.messages.some(message => message.id === record.id));
      if (!chat && incoming) return false; // Retain in the durable shadow until its chat arrives.
      if (chat) {
        const existing = chat.messages.find(message=>message.id===record.id);
        const previousOrder = new Map(chat.messages.map((message,index)=>[message.id,index]));
        chat.messages = replace(chat.messages,record.id,value === null ? null : messageSchema.parse({...messageSchema.parse(value),codexTurns:existing?.codexTurns ?? [],activity:existing?.activity ?? [],...(existing?.guidedGeneration ? {guidedGeneration:existing.guidedGeneration} : {})}));
        chat.messages.sort((a,b)=>{
          const time = a.createdAt.localeCompare(b.createdAt);
          if (time) return time;
          const creation = (id:string) => z.object({createdCursor:z.string().regex(/^\d+$/).optional()}).parse(id===record.id ? record : ordering[recordKey({kind:'message',id})] ?? {}).createdCursor;
          const left = creation(a.id),right = creation(b.id);
          if (left && right) return BigInt(left)<BigInt(right) ? -1 : BigInt(left)>BigInt(right) ? 1 : 0;
          return (previousOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER)-(previousOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
        });
      }
      break;
    }
    case 'chatFolder': state.chatFolders = replace(state.chatFolders,record.id,value === null ? null : chatFolderSchema.parse(value)); break;
    case 'attempt': case 'practice.attempt': state.attempts = replace(state.attempts,record.id,value === null ? null : attemptSchema.parse(value)); break;
    case 'reviewMemory': state.memories = replace(state.memories,record.id,value === null ? null : memorySchema.parse(value)); break;
    case 'learnerMemory': state.assistantMemories = replace(state.assistantMemories,record.id,value === null ? null : assistantMemorySchema.parse(value)); break;
    case 'preferences': if (value !== null) {
      const supplied = z.record(z.string(),z.unknown()).parse(value);
      Object.assign(state.settings,preferencesSchema.strict().parse({...preferencesSchema.parse(state.settings),...supplied}));
    } break;
    case 'studySession': case 'studyGoal': state.studyLog = applyStudyCloudRecord(state.studyLog,record,now); break;
    case 'practice.draft': { const prior=state.practiceDrafts.find(row=>row.id===record.id); state.practiceDrafts = replace(state.practiceDrafts,record.id,value === null ? prior ? {...prior,deletedAt:record.updatedAt} : null : quizDraftSchema.parse(value)); break; }
    case 'practice.learningNeed': { const prior=state.learningNeeds.find(row=>row.id===record.id); state.learningNeeds = replace(state.learningNeeds,record.id,value === null ? prior ? {...prior,deletedAt:record.updatedAt} : null : learningNeedSchema.parse(value)); break; }
    case 'interactiveProgress': { const prior=state.interactiveResourceProgress.find(row=>row.id===record.id); state.interactiveResourceProgress = replace(state.interactiveResourceProgress,record.id,value === null ? prior ? {...prior,deletedAt:record.updatedAt} : null : interactiveResourceProgressSchema.parse(value)); break; }
    case 'calendarEvent': {
      const existing = state.events.find(item=>item.id===record.id);
      if (value === null) {
        const event = calendarEventSchema.safeParse(existing);
        if (event.success) state.events = replace(state.events,record.id,{...event.data,deletedAt:record.updatedAt});
      } else state.events = replace(state.events,record.id,calendarEventSchema.parse(value));
      break;
    }
    default: return false;
  }
  return true;
}
