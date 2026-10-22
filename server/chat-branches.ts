import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chatSchema, type Chat, type Message } from '../shared/schema';
import { HttpError } from './errors';

export const branchInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation:z.literal('continue'), messageId:z.string().min(1) }).strict(),
  z.object({ operation:z.literal('edit'), messageId:z.string().min(1), content:z.string().trim().min(1).max(100_000) }).strict(),
  z.object({ operation:z.literal('regenerate'), messageId:z.string().min(1) }).strict(),
]);
export type BranchInput = z.infer<typeof branchInputSchema>;
export type ChatBranch = {
  chat: Chat;
  fork: { kind:'before' | 'through'; turnId:string } | null;
  promptMessageId:string | null;
};

function requireCompleted(message: Message | undefined): Message {
  if (!message || message.role !== 'assistant' || (!message.content.trim() && message.resourceIds.length === 0)) {
    throw new HttpError(400, 'Choose a completed assistant reply.');
  }
  return message;
}

/** Constructs an independent local history. The caller guards active responses and pending questions. */
export function createChatBranch(parent: Chat, value: BranchInput): ChatBranch {
  const input = branchInputSchema.parse(value);
  const selectedIndex = parent.messages.findIndex(message => message.id === input.messageId);
  const selected = parent.messages[selectedIndex];
  if (!selected || parent.deletedAt !== null) throw new HttpError(404, 'Message not found');

  const now = new Date().toISOString();
  let retained: Message[];
  let checkpoint: Message | undefined;
  let prompt: Message | undefined;
  let fork: ChatBranch['fork'] = null;

  if (input.operation === 'continue') {
    const checkpointIndex = selected.role === 'assistant' ? selectedIndex : parent.messages.findIndex((message, index) => index > selectedIndex && message.role === 'assistant');
    checkpoint = requireCompleted(parent.messages[checkpointIndex]);
    retained = parent.messages.slice(0, checkpointIndex + 1);
    const turn = checkpoint.codexTurns.at(-1);
    if (turn) fork = { kind:'through', turnId:turn.turnId };
  } else if (input.operation === 'edit') {
    if (selected.role !== 'user') throw new HttpError(400, 'Only user messages can be edited.');
    const response = requireCompleted(parent.messages.find((message, index) => index > selectedIndex && message.role === 'assistant'));
    const turn = response.codexTurns.find(candidate => candidate.promptMessageId === selected.id);
    if (turn) fork = { kind:'before', turnId:turn.turnId };
    retained = parent.messages.slice(0, selectedIndex);
    checkpoint = retained.at(-1);
    prompt = { ...selected, content:input.content, createdAt:now, resourceIds:[], activity:[] };
    retained.push(prompt);
  } else {
    requireCompleted(selected);
    retained = parent.messages.slice(0, selectedIndex);
    checkpoint = retained.at(-1);
    prompt = [...retained].reverse().find(message => message.role === 'user');
    if (!prompt) throw new HttpError(400, 'This reply has no preceding user prompt.');
    const turn = selected.codexTurns[0];
    if (turn) fork = { kind:'before', turnId:turn.turnId };
  }

  let promptMessageId: string | null = null;
  const messages = retained.map(message => {
    const copied = structuredClone(message);
    copied.id = randomUUID();
    copied.codexTurns = [];
    if (message === prompt) promptMessageId = copied.id;
    return copied;
  });
  const titlePrefix = input.operation === 'edit' ? 'Edited: ' : input.operation === 'regenerate' ? 'Alternate: ' : 'Branch: ';
  const sourceExcerpt = (input.operation === 'edit' ? input.content : selected.content).replace(/\s+/g,' ').trim();
  const titleExcerpt = (sourceExcerpt || parent.title.replace(/\s+/g,' ').trim()).slice(0,60);
  const chat = chatSchema.parse({
    id:randomUUID(), title:`${titlePrefix}${titleExcerpt}`.slice(0,200), createdAt:now, updatedAt:now,
    modelSelection:structuredClone(parent.modelSelection), pinnedAt:parent.pinnedAt,
    folderId:parent.folderId, sortOrder:-Date.now(), messages,
    activity:[], codexThreadId:null,
    lineage:{ schemaVersion:1, kind:'branch', operation:input.operation,
      parentChatId:parent.id, sourceMessageId:selected.id, checkpointMessageId:checkpoint?.id ?? null, promptMessageId },
  });
  return { chat, fork, promptMessageId };
}
