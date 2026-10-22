import type { Chat } from './schema';

export type ScopedChatLineage = {workspaceId:string;chat:Chat};
export type ChatAttachmentOwner = {workspaceId:string;chatId:string};

const sameIds = (left:readonly string[], right:readonly string[]) => left.length === right.length && left.every((id,index) => id === right[index]);
const completed = (message:Chat['messages'][number] | undefined) => message?.role === 'assistant' && (message.content.trim().length > 0 || message.resourceIds.length > 0);
const owns = (chat:Chat, attachmentId:string) => chat.messages.some(message => message.attachmentIds.includes(attachmentId));

/** Returns the attachments inherited across a verified parent/child history boundary. */
function inheritedAttachments(parent:Chat, child:Chat): Set<string> | null {
  const lineage = child.lineage;
  if (lineage.kind !== 'branch') return null;
  const sourceIndex = parent.messages.findIndex(message => message.id === lineage.sourceMessageId);
  const source = parent.messages[sourceIndex];
  if (!source) return null;
  let count:number;
  let promptIndex = -1;
  let checkpointIndex:number;
  if (lineage.operation === 'continue') {
    checkpointIndex = source.role === 'assistant' ? sourceIndex : parent.messages.findIndex((message,index) => index > sourceIndex && message.role === 'assistant');
    if (!completed(parent.messages[checkpointIndex]) || lineage.promptMessageId !== null) return null;
    count = checkpointIndex + 1;
  } else if (lineage.operation === 'edit') {
    if (source.role !== 'user' || !completed(parent.messages.find((message,index) => index > sourceIndex && message.role === 'assistant'))) return null;
    count = sourceIndex + 1;
    checkpointIndex = sourceIndex - 1;
    promptIndex = sourceIndex;
  } else {
    if (!completed(source)) return null;
    count = sourceIndex;
    checkpointIndex = sourceIndex - 1;
    for (let index = sourceIndex - 1; index >= 0; index--) {
      if (parent.messages[index]?.role === 'user') { promptIndex = index; break; }
    }
    if (promptIndex < 0) return null;
  }
  if (lineage.checkpointMessageId !== (parent.messages[checkpointIndex]?.id ?? null) || child.messages.length < count) return null;
  if (lineage.promptMessageId !== null && lineage.promptMessageId !== child.messages[promptIndex]?.id) return null;
  const attachments = new Set<string>();
  for (let index = 0; index < count; index++) {
    const original = parent.messages[index], copied = child.messages[index];
    if (!original || !copied || copied.id === original.id || copied.role !== original.role) return null;
    const edited = lineage.operation === 'edit' && index === sourceIndex;
    if (edited ? !copied.content.trim() : copied.content !== original.content) return null;
    if (!sameIds(copied.resourceIds,edited ? [] : original.resourceIds) || !sameIds(copied.attachmentIds,original.attachmentIds)) return null;
    for (const attachmentId of copied.attachmentIds) attachments.add(attachmentId);
  }
  return attachments;
}

/** Supply persisted chats including archived ancestors. Workspace IDs must come from verified storage/auth. */
export function canShareChatAttachment(chats:readonly ScopedChatLineage[], attachmentId:string, from:ChatAttachmentOwner, to:ChatAttachmentOwner):boolean {
  if (!from.workspaceId || from.workspaceId !== to.workspaceId) return false;
  const scopedChats = chats.filter(record => record.workspaceId === from.workspaceId).map(record => record.chat);
  const fromChatId = from.chatId, toChatId = to.chatId;
  const byId = new Map<string,Chat>();
  const messageIds = new Set<string>();
  for (const chat of scopedChats) {
    if (!chat.id || byId.has(chat.id)) return false;
    byId.set(chat.id,chat);
    for (const message of chat.messages) {
      if (!message.id || messageIds.has(message.id)) return false;
      messageIds.add(message.id);
    }
  }
  const fromChat = byId.get(fromChatId), toChat = byId.get(toChatId);
  if (!fromChat || !toChat || toChat.deletedAt !== null || !attachmentId || !owns(fromChat,attachmentId) || !owns(toChat,attachmentId)) return false;
  const inherited = new Map<string,Set<string>>();
  const validity = new Map<string,boolean>();
  function validAncestry(chat:Chat, path:Set<string>):boolean {
    const cached = validity.get(chat.id);
    if (cached !== undefined) return cached;
    if (path.has(chat.id)) return false;
    if (chat.lineage.kind === 'root') { validity.set(chat.id,true); return true; }
    const parent = byId.get(chat.lineage.parentChatId);
    const associations = parent && inheritedAttachments(parent,chat);
    const next = new Set(path).add(chat.id);
    const valid = !!parent && associations !== null && associations !== undefined && validAncestry(parent,next);
    validity.set(chat.id,valid);
    if (valid && associations) inherited.set(chat.id,associations);
    return valid;
  }
  if (!validAncestry(fromChat,new Set()) || !validAncestry(toChat,new Set())) return false;
  if (fromChatId === toChatId) return true;
  const graph = new Map<string,string[]>();
  for (const chat of scopedChats) {
    if (chat.lineage.kind !== 'branch' || !owns(chat,attachmentId) || !validAncestry(chat,new Set()) || !inherited.get(chat.id)?.has(attachmentId)) continue;
    const parentId = chat.lineage.parentChatId;
    graph.set(chat.id,[...(graph.get(chat.id) ?? []),parentId]);
    graph.set(parentId,[...(graph.get(parentId) ?? []),chat.id]);
  }
  const visited = new Set([fromChatId]);
  const queue = [fromChatId];
  for (let index = 0; index < queue.length; index++) {
    for (const neighbor of graph.get(queue[index] ?? '') ?? []) {
      if (neighbor === toChatId) return true;
      if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
  }
  return false;
}
