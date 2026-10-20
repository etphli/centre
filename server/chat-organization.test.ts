import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatFolderSchema, chatSchema, type Chat } from '../shared/schema';
import { HttpError } from './errors';
import { route } from './chat-organization';
import { emptySnapshot, Store } from './store';

const now = '2026-10-20T00:00:00.000Z';

function makeChat(id: string, fields: Partial<Chat> = {}): Chat {
  return chatSchema.parse({
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    messages: [],
    ...fields,
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'centre-chat-organization-'));
  const store = await Store.open(directory);
  return {
    directory,
    store,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

async function call(store: Store, method: string, path: string, value: unknown = {}) {
  const result = await route(store, method, path, value);
  assert.ok(result, `Expected an organization route for ${method} ${path}`);
  return result.value;
}

function expectHttpError(status: number) {
  return (error: unknown) => error instanceof HttpError && error.status === status;
}

test('old snapshots receive chat organization defaults and saved organization survives reopening', async () => {
  const f = await fixture();
  try {
    const legacy = {
      ...emptySnapshot(),
      chats: [{ id: 'legacy-chat', title: 'Legacy', createdAt: now, updatedAt: now, messages: [] }],
    };
    Reflect.deleteProperty(legacy, 'chatFolders');
    await writeFile(join(f.directory, 'state.json'), JSON.stringify(legacy));

    const reopenedLegacy = await Store.open(f.directory);
    assert.equal(reopenedLegacy.state.chatFolders.length, 0);
    assert.equal(reopenedLegacy.state.chats[0]?.pinnedAt, null);
    assert.equal(reopenedLegacy.state.chats[0]?.folderId, null);
    assert.equal(reopenedLegacy.state.chats[0]?.sortOrder, 0);

    const folder = chatFolderSchema.parse(await call(reopenedLegacy, 'POST', '/api/chat-folders', { name: '  Biology  ' }));
    assert.equal(folder.name, 'Biology');
    const secondFolder = chatFolderSchema.parse(await call(reopenedLegacy, 'POST', '/api/chat-folders', { name: 'Chemistry' }));
    await call(reopenedLegacy, 'PATCH', `/api/chat-folders/${secondFolder.id}`, { beforeFolderId: folder.id });
    assert.deepEqual(reopenedLegacy.state.chatFolders.slice().sort((left, right) => left.sortOrder - right.sortOrder).map(candidate => [candidate.name, candidate.sortOrder]), [
      ['Chemistry', 0], ['Biology', 1],
    ]);
    await assert.rejects(
      route(reopenedLegacy, 'PATCH', `/api/chat-folders/${secondFolder.id}`, { beforeFolderId: 'missing-folder' }),
      expectHttpError(404),
    );
    await call(reopenedLegacy, 'PATCH', '/api/chats/legacy-chat/organize', { pinned: true, folderId: folder.id });
    await call(reopenedLegacy, 'PATCH', `/api/chat-folders/${folder.id}`, { collapsed: true });

    const persisted = await Store.open(f.directory);
    assert.deepEqual(persisted.state.chatFolders.slice().sort((left, right) => left.sortOrder - right.sortOrder).map(({ id, name, sortOrder, collapsed }) => ({ id, name, sortOrder, collapsed })), [
      { id: secondFolder.id, name: 'Chemistry', sortOrder: 0, collapsed: false },
      { id: folder.id, name: 'Biology', sortOrder: 1, collapsed: true },
    ]);
    assert.equal(persisted.state.chats[0]?.pinnedAt !== null, true);
    assert.equal(persisted.state.chats[0]?.folderId, folder.id);
    assert.equal(persisted.state.chats[0]?.sortOrder, 0);
  } finally {
    await f.cleanup();
  }
});

test('chat reordering stays within the target group and rejects missing or archived targets', async () => {
  const f = await fixture();
  try {
    f.store.state.chats.push(makeChat('chat-a'), makeChat('chat-b'), makeChat('chat-c'));
    await f.store.save();

    await call(f.store, 'PATCH', '/api/chats/chat-b/organize', { beforeChatId: 'chat-a' });
    assert.deepEqual(f.store.state.chats.map(chat => [chat.id, chat.sortOrder]), [
      ['chat-a', 1], ['chat-b', 0], ['chat-c', 2],
    ]);
    await call(f.store, 'PATCH', '/api/chats/chat-b/organize', { beforeChatId: null });
    assert.deepEqual(f.store.state.chats.map(chat => [chat.id, chat.sortOrder]), [
      ['chat-a', 0], ['chat-b', 2], ['chat-c', 1],
    ]);

    const folder = chatFolderSchema.parse(await call(f.store, 'POST', '/api/chat-folders', { name: 'Revision' }));
    await assert.rejects(
      route(f.store, 'PATCH', '/api/chats/chat-a/organize', { folderId: 'missing-folder' }),
      expectHttpError(404),
    );
    await call(f.store, 'PATCH', '/api/chats/chat-a/organize', { folderId: folder.id });
    await assert.rejects(
      route(f.store, 'PATCH', '/api/chats/chat-b/organize', { beforeChatId: 'chat-a' }),
      expectHttpError(400),
    );
    assert.equal(f.store.state.chats.find(chat => chat.id === 'chat-b')?.folderId, null);

    await call(f.store, 'PATCH', '/api/chats/chat-b/organize', { folderId: folder.id, beforeChatId: 'chat-a' });
    assert.equal(f.store.state.chats.find(chat => chat.id === 'chat-b')?.sortOrder, 0);
    assert.equal(f.store.state.chats.find(chat => chat.id === 'chat-a')?.sortOrder, 1);

    const chatB = f.store.state.chats.find(chat => chat.id === 'chat-b');
    assert.ok(chatB);
    const folderBeforePin = chatB.folderId;
    await call(f.store, 'PATCH', '/api/chats/chat-b/organize', { pinned: true });
    assert.equal(chatB.folderId, folderBeforePin);
    assert.ok(chatB.pinnedAt);
    await call(f.store, 'PATCH', '/api/chats/chat-c/organize', { pinned: true, beforeChatId: 'chat-b' });
    assert.deepEqual(
      f.store.state.chats.filter(chat => chat.pinnedAt !== null).sort((left, right) => left.sortOrder - right.sortOrder).map(chat => chat.id),
      ['chat-c', 'chat-b'],
    );

    const chatA = f.store.state.chats.find(chat => chat.id === 'chat-a');
    assert.ok(chatA);
    chatA.deletedAt = now;
    await assert.rejects(
      route(f.store, 'PATCH', '/api/chats/chat-b/organize', { beforeChatId: 'chat-a' }),
      expectHttpError(404),
    );
    await assert.rejects(
      route(f.store, 'PATCH', '/api/chats/chat-b/organize', { pinned: false, folderId: null, beforeChatId: 'chat-a' }),
      expectHttpError(404),
    );
  } finally {
    await f.cleanup();
  }
});

test('removing a folder moves chats out and preserves their histories', async () => {
  const f = await fixture();
  try {
    const activeInbox = makeChat('inbox-chat', { messages: [{ id: 'inbox-message', role: 'user', resourceIds:[], attachmentIds:[], activity:[], responseDurationMs:null, content: 'Inbox text', createdAt: now }] });
    const folderChat = makeChat('folder-chat', { messages: [{ id: 'folder-message', role: 'user', resourceIds:[], attachmentIds:[], activity:[], responseDurationMs:null, content: 'Keep this history', createdAt: now }] });
    const pinnedChat = makeChat('pinned-chat', { messages: [{ id: 'pinned-message', role: 'assistant', resourceIds:[], attachmentIds:[], activity:[], responseDurationMs:null, content: 'Pinned history', createdAt: now }] });
    const archivedChat = makeChat('archived-chat', { messages: [{ id: 'archived-message', role: 'user', resourceIds:[], attachmentIds:[], activity:[], responseDurationMs:null, content: 'Archived history', createdAt: now }] });
    f.store.state.chats.push(activeInbox, folderChat, pinnedChat, archivedChat);
    const folder = chatFolderSchema.parse(await call(f.store, 'POST', '/api/chat-folders', { name: 'Old folder' }));
    await call(f.store, 'PATCH', '/api/chats/folder-chat/organize', { folderId: folder.id });
    await call(f.store, 'PATCH', '/api/chats/pinned-chat/organize', { folderId: folder.id, pinned: true });
    await call(f.store, 'PATCH', '/api/chats/archived-chat/organize', { folderId: folder.id });
    archivedChat.deletedAt = now;

    const result = await call(f.store, 'POST', `/api/chat-folders/${folder.id}/remove`);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(f.store.state.chatFolders, []);
    assert.equal(activeInbox.folderId, null);
    assert.equal(folderChat.folderId, null);
    assert.equal(pinnedChat.folderId, null);
    assert.equal(archivedChat.folderId, null);
    assert.equal(archivedChat.deletedAt, now);
    assert.equal(folderChat.messages[0]?.content, 'Keep this history');
    assert.equal(pinnedChat.messages[0]?.content, 'Pinned history');
    assert.equal(archivedChat.messages[0]?.content, 'Archived history');
    assert.equal(activeInbox.sortOrder, 0);
    assert.equal(folderChat.sortOrder, 1);

    const reopened = await Store.open(f.directory);
    assert.equal(reopened.state.chats.find(chat => chat.id === 'folder-chat')?.messages[0]?.content, 'Keep this history');
    assert.equal(reopened.state.chats.find(chat => chat.id === 'archived-chat')?.deletedAt, now);
    assert.equal(reopened.state.chats.find(chat => chat.id === 'archived-chat')?.folderId, null);
  } finally {
    await f.cleanup();
  }
});
