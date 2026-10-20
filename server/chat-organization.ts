import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chatFolderSchema, type Chat, type ChatFolder } from '../shared/schema';
import { HttpError, requireFound } from './errors';
import { Store } from './store';

const organizeChatInput = z.object({
  pinned: z.boolean().optional(),
  folderId: z.string().min(1).nullable().optional(),
  beforeChatId: z.string().min(1).nullable().optional(),
}).strict().refine(input => Object.values(input).some(value => value !== undefined), 'Choose an organization change.');

const createFolderInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const updateFolderInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  collapsed: z.boolean().optional(),
  beforeFolderId: z.string().min(1).nullable().optional(),
}).strict().refine(input => Object.values(input).some(value => value !== undefined), 'Choose a folder change.');
const emptyInput = z.object({}).strict();

type ChatGroup = { kind: 'pinned' } | { kind: 'folder'; folderId: string | null };

function groupFor(chat: Chat): ChatGroup {
  return chat.pinnedAt === null ? { kind: 'folder', folderId: chat.folderId } : { kind: 'pinned' };
}

function sameGroup(left: ChatGroup, right: ChatGroup): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'pinned' || left.folderId === (right.kind === 'folder' ? right.folderId : null);
}

function orderedChats(chats: Chat[]): Chat[] {
  return [...chats].sort((left, right) => left.sortOrder - right.sortOrder);
}

function activeChatsInGroup(store: Store, group: ChatGroup): Chat[] {
  return orderedChats(store.state.chats.filter(chat => chat.deletedAt === null && sameGroup(groupFor(chat), group)));
}

function rankChats(chats: Chat[]): void {
  chats.forEach((chat, index) => { chat.sortOrder = index; });
}

function orderedFolders(store: Store): ChatFolder[] {
  return [...store.state.chatFolders].sort((left, right) => left.sortOrder - right.sortOrder);
}

function rankFolders(folders: ChatFolder[]): void {
  folders.forEach((folder, index) => { folder.sortOrder = index; });
}

function decodeId(encoded: string | undefined): string {
  return decodeURIComponent(encoded ?? '');
}

export async function route(
  store: Store,
  method: string,
  path: string,
  value: unknown,
): Promise<{ value: unknown } | null> {
  let match = /^\/api\/chats\/([^/]+)\/organize$/.exec(path);
  if (method === 'PATCH' && match) {
    const input = organizeChatInput.parse(value);
    const chat = requireFound(store.state.chats.find(candidate => candidate.id === decodeId(match?.[1]) && candidate.deletedAt === null), 'Chat');
    const oldGroup = groupFor(chat);
    const pinnedAt = input.pinned === undefined ? chat.pinnedAt : input.pinned ? chat.pinnedAt ?? new Date().toISOString() : null;
    const folderId = input.folderId === undefined ? chat.folderId : input.folderId;
    if (folderId !== null) requireFound(store.state.chatFolders.find(folder => folder.id === folderId), 'Chat folder');
    const updatedChat: Chat = { ...chat, pinnedAt, folderId };
    const newGroup = groupFor(updatedChat);
    const groupChanged = !sameGroup(oldGroup, newGroup);
    const oldOrder = activeChatsInGroup(store, oldGroup);

    let beforeChat: Chat | undefined;
    if (input.beforeChatId !== undefined && input.beforeChatId !== null) {
      beforeChat = requireFound(
        store.state.chats.find(candidate => candidate.id === input.beforeChatId && candidate.deletedAt === null),
        'Chat',
      );
      if (beforeChat.id === chat.id) {
        if (groupChanged) throw new HttpError(400, 'A chat cannot be moved before itself.');
      } else if (!sameGroup(groupFor(beforeChat), newGroup)) {
        throw new HttpError(400, 'The target chat must be in the same organization group.');
      }
    }

    const targetOrder = activeChatsInGroup(store, newGroup).filter(candidate => candidate.id !== chat.id);
    let nextOrder: Chat[];
    if (input.beforeChatId === chat.id) {
      nextOrder = oldOrder;
    } else if (input.beforeChatId !== undefined && input.beforeChatId !== null) {
      const beforeIndex = targetOrder.findIndex(candidate => candidate.id === beforeChat?.id);
      targetOrder.splice(beforeIndex, 0, chat);
      nextOrder = targetOrder;
    } else if (input.beforeChatId === null || groupChanged) {
      targetOrder.push(chat);
      nextOrder = targetOrder;
    } else {
      nextOrder = oldOrder;
    }

    chat.pinnedAt = pinnedAt;
    chat.folderId = folderId;
    if (groupChanged) rankChats(oldOrder.filter(candidate => candidate.id !== chat.id));
    rankChats(nextOrder);
    await store.save();
    return { value: chat };
  }

  if (method === 'POST' && path === '/api/chat-folders') {
    const input = createFolderInput.parse(value);
    const folders = orderedFolders(store);
    rankFolders(folders);
    const folder = chatFolderSchema.parse({ id: randomUUID(), name: input.name, sortOrder: folders.length, collapsed: false });
    store.state.chatFolders.push(folder);
    await store.save();
    return { value: folder };
  }

  match = /^\/api\/chat-folders\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && match) {
    const input = updateFolderInput.parse(value);
    const folder = requireFound(store.state.chatFolders.find(candidate => candidate.id === decodeId(match?.[1])), 'Chat folder');
    const currentOrder = orderedFolders(store);
    const nextOrder = currentOrder.filter(candidate => candidate.id !== folder.id);

    if (input.beforeFolderId !== undefined && input.beforeFolderId !== null) {
      requireFound(store.state.chatFolders.find(candidate => candidate.id === input.beforeFolderId), 'Chat folder');
      if (input.beforeFolderId !== folder.id) {
        const beforeIndex = nextOrder.findIndex(candidate => candidate.id === input.beforeFolderId);
        nextOrder.splice(beforeIndex, 0, folder);
      } else {
        nextOrder.splice(currentOrder.findIndex(candidate => candidate.id === folder.id), 0, folder);
      }
    } else if (input.beforeFolderId === null) {
      nextOrder.push(folder);
    } else {
      nextOrder.splice(currentOrder.findIndex(candidate => candidate.id === folder.id), 0, folder);
    }

    if (input.name !== undefined) folder.name = input.name;
    if (input.collapsed !== undefined) folder.collapsed = input.collapsed;
    rankFolders(nextOrder);
    await store.save();
    return { value: folder };
  }

  match = /^\/api\/chat-folders\/([^/]+)\/remove$/.exec(path);
  if (method === 'POST' && match) {
    emptyInput.parse(value);
    const folder = requireFound(store.state.chatFolders.find(candidate => candidate.id === decodeId(match?.[1])), 'Chat folder');
    const inboxGroup: ChatGroup = { kind: 'folder', folderId: null };
    const inboxOrder = activeChatsInGroup(store, inboxGroup);
    const removedFolderOrder = activeChatsInGroup(store, { kind: 'folder', folderId: folder.id });
    store.state.chatFolders = orderedFolders(store).filter(candidate => candidate.id !== folder.id);
    for (const chat of store.state.chats) {
      if (chat.folderId === folder.id) chat.folderId = null;
    }
    rankChats([...inboxOrder, ...removedFolderOrder]);
    rankFolders(orderedFolders(store));
    await store.save();
    return { value: { ok: true } };
  }

  return null;
}
