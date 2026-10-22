import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSchema, messageSchema, type Chat } from '../shared/schema';
import { searchResultsSchema } from '../shared/search';
import { AttachmentStore } from './attachments';
import { HttpError } from './errors';
import { createService } from './index';
import { SearchIndex } from './search-index';
import { Store } from './store';

const now = '2026-10-22T00:00:00.000Z';
const phrase = 'retainedsidecarphrase';

function root(id: string, attachmentIds: string[]): Chat {
  return chatSchema.parse({
    id, title: `Conversation ${id}`, createdAt: now, updatedAt: now,
    messages: [
      { id: `${id}-prompt`, role: 'user', content: 'Read the study material', attachmentIds, createdAt: now },
      { id: `${id}-reply`, role: 'assistant', content: 'Here is the completed explanation', createdAt: now },
    ],
  });
}

function branch(parent: Chat, id: string): Chat {
  const checkpoint = parent.messages[1];
  assert.ok(checkpoint);
  return chatSchema.parse({
    ...parent, id, title: `Conversation ${id}`, deletedAt: null,
    lineage: { schemaVersion: 1, kind: 'branch', operation: 'continue', parentChatId: parent.id, sourceMessageId: checkpoint.id, checkpointMessageId: checkpoint.id, promptMessageId: null },
    messages: parent.messages.slice(0, 2).map((message, index) => ({ ...message, id: `${id}-${index}` })),
  });
}

async function fixture(run: (store: Store, attachments: AttachmentStore, attachmentId: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'centre-branch-search-'));
  try {
    const store = await Store.open(directory);
    const attachments = new AttachmentStore(directory);
    const attachment = await attachments.upload({ name: 'revision.txt', mimeType: 'text/plain', data: Buffer.from(phrase).toString('base64') });
    await run(store, attachments, attachment.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function persistedIndex(store: Store): Promise<SearchIndex> {
  await store.save();
  const persisted = await Store.open(store.directory);
  const index = new SearchIndex(new AttachmentStore(store.directory));
  await index.rebuild(persisted.state);
  return index;
}

function expectTargets(index: SearchIndex, chats: readonly Chat[], attachmentId: string) {
  const results = searchResultsSchema.parse(index.search(phrase));
  assert.deepEqual(new Set(results.map(result => result.id)), new Set(chats.map(chat => `attachment:${chat.id}:${chat.messages[0]?.id}:${attachmentId}`)));
  for (const chat of chats) {
    const result = results.find(value => value.target.kind === 'chat' && value.target.chatId === chat.id);
    assert.ok(result);
    assert.deepEqual(result.target, { kind: 'chat', chatId: chat.id, messageId: chat.messages[0]?.id });
    assert.ok(result.snippet.includes(phrase));
  }
}

function expectConflict(attachments: AttachmentStore, chats: readonly Chat[], attachmentId: string, targetId: string) {
  assert.throws(() => attachments.assertMessageOwnership(chats, [attachmentId], targetId), error => error instanceof HttpError && error.status === 409);
}

test('persisted parent, child, sibling and nested branches search the same sidecar through their retained messages', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const parent = root('parent', [attachmentId]);
    const child = branch(parent, 'child');
    const sibling = branch(parent, 'sibling');
    const nested = branch(child, 'nested');
    store.state.chats.push(parent, child, sibling, nested);
    for (const chat of store.state.chats) assert.doesNotThrow(() => attachments.assertMessageOwnership(store.state.chats, [attachmentId], chat.id));
    expectTargets(await persistedIndex(store), store.state.chats, attachmentId);
  });
});

test('archiving the original retains active branch hits and excludes the archived chat', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const parent = root('archived-parent', [attachmentId]);
    const child = branch(parent, 'retained-child');
    const sibling = branch(parent, 'retained-sibling');
    parent.deletedAt = now;
    store.state.chats.push(parent, child, sibling);
    assert.doesNotThrow(() => attachments.assertMessageOwnership(store.state.chats, [attachmentId], child.id));
    expectTargets(await persistedIndex(store), [child, sibling], attachmentId);
    child.deletedAt = now;
    sibling.deletedAt = now;
    assert.deepEqual((await persistedIndex(store)).search(phrase), []);
  });
});

test('same-chat retries retain the first message target and fresh uploads have no conflicting owner', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const chat = root('retry', [attachmentId]);
    chat.messages.push(messageSchema.parse({ id: 'retry-again', role: 'user', content: 'Use the same material again', attachmentIds: [attachmentId], createdAt: now }));
    store.state.chats.push(chat);
    assert.doesNotThrow(() => attachments.assertMessageOwnership(store.state.chats, [attachmentId], chat.id));
    const fresh = await attachments.upload({ name: 'fresh.txt', mimeType: 'text/plain', data: Buffer.from('fresh upload').toString('base64') });
    assert.doesNotThrow(() => attachments.assertMessageOwnership(store.state.chats, [fresh.id], chat.id));
    expectTargets(await persistedIndex(store), [chat], attachmentId);
  });
});

test('a forged reference from an unrelated root poisons every target even when the foreign owner is archived', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const parent = root('trusted-parent', [attachmentId]);
    const child = branch(parent, 'trusted-child');
    const foreign = root('unrelated-root', [attachmentId]);
    store.state.chats.push(parent, child, foreign);
    for (const archived of [false, true]) {
      foreign.deletedAt = archived ? now : null;
      for (const chat of store.state.chats) expectConflict(attachments, store.state.chats, attachmentId, chat.id);
      assert.deepEqual((await persistedIndex(store)).search(phrase), []);
    }
  });
});

test('same-family attachments introduced after the branch checkpoint cannot be forged into the child', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const parent = root('late-parent', []);
    const child = branch(parent, 'early-child');
    parent.messages.push(
      messageSchema.parse({ id: 'late-upload', role: 'user', content: 'Later study material', attachmentIds: [attachmentId], createdAt: now }),
      messageSchema.parse({ id: 'late-reply', role: 'assistant', content: 'Later completed response', createdAt: now }),
    );
    child.messages.push(messageSchema.parse({ id: 'forged-late-upload', role: 'user', content: 'Forged later reference', attachmentIds: [attachmentId], createdAt: now }));
    store.state.chats.push(parent, child);
    expectConflict(attachments, store.state.chats, attachmentId, child.id);
    expectConflict(attachments, store.state.chats, attachmentId, parent.id);
    assert.deepEqual((await persistedIndex(store)).search(phrase), []);
  });
});

test('lineage IDs alone cannot authorize a branch whose retained transcript was changed', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    const parent = root('original-history', [attachmentId]);
    const child = branch(parent, 'forged-history');
    const copiedPrompt = child.messages[0];
    assert.ok(copiedPrompt);
    copiedPrompt.content = 'Different content carrying the same attachment';
    store.state.chats.push(parent, child);
    expectConflict(attachments, store.state.chats, attachmentId, child.id);
    expectConflict(attachments, store.state.chats, attachmentId, parent.id);
    assert.deepEqual((await persistedIndex(store)).search(phrase), []);
  });
});

test('missing ancestors, cyclic lineage and duplicate chat IDs fail closed at search and send boundaries', async t => {
  for (const corruption of ['missing ancestor', 'cycle', 'duplicate chat ID']) {
    await t.test(corruption, async () => {
      await fixture(async (store, attachments, attachmentId) => {
        const parent = root('ancestor', [attachmentId]);
        const child = branch(parent, 'descendant');
        if (corruption === 'missing ancestor') {
          const missing = root('absent', [attachmentId]);
          const orphan = branch(missing, 'orphan');
          store.state.chats.push(child, orphan);
        } else if (corruption === 'cycle') {
          const checkpoint = child.messages[1];
          assert.ok(checkpoint);
          const cyclicParent = chatSchema.parse({
            ...parent,
            lineage: { schemaVersion: 1, kind: 'branch', operation: 'continue', parentChatId: child.id, sourceMessageId: checkpoint.id, checkpointMessageId: checkpoint.id, promptMessageId: null },
          });
          store.state.chats.push(cyclicParent, child);
        } else {
          store.state.chats.push(parent, child, root(parent.id, []));
        }
        for (const chat of store.state.chats.filter(chat => chat.messages.some(message => message.attachmentIds.includes(attachmentId)))) {
          expectConflict(attachments, store.state.chats, attachmentId, chat.id);
        }
        assert.deepEqual((await persistedIndex(store)).search(phrase), []);
      });
    });
  }
});

test('independent workspace data directories cannot read each other\'s sidecars through forged stable IDs', async () => {
  await fixture(async (store, attachments, attachmentId) => {
    store.state.chats.push(root('workspace-a', [attachmentId]));
    const directory = await mkdtemp(join(tmpdir(), 'centre-foreign-workspace-search-'));
    try {
      const foreignStore = await Store.open(directory);
      foreignStore.state.chats.push(root('forged-workspace-b', [attachmentId]));
      const foreignAttachments = new AttachmentStore(directory);
      assert.notEqual(foreignAttachments.workspaceId, attachments.workspaceId);
      assert.equal(new AttachmentStore(store.directory).workspaceId, attachments.workspaceId);
      await assert.rejects(foreignAttachments.searchText(attachmentId), error => error instanceof HttpError && error.status === 404);
      await assert.rejects(foreignAttachments.get(attachmentId), error => error instanceof HttpError && error.status === 404);
      assert.deepEqual((await persistedIndex(foreignStore)).search(phrase), []);
      expectTargets(await persistedIndex(store), store.state.chats, attachmentId);
      assert.ok((await attachments.searchText(attachmentId))?.text.includes(phrase));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('the local API preserves retained branch attachment search and sends while denying unrelated reuse', async () => {
  await fixture(async (store, _attachments, attachmentId) => {
    const parent = root('api-parent', [attachmentId]);
    const child = branch(parent, 'api-child');
    const sibling = branch(parent, 'api-sibling');
    const unrelated = root('api-unrelated', []);
    parent.deletedAt = now;
    store.state.chats.push(parent, child, sibling, unrelated);
    await store.save();
    const previousBinary = process.env.CENTRE_CODEX_BIN;
    process.env.CENTRE_CODEX_BIN = join(store.directory, 'missing-codex');
    let service: Awaited<ReturnType<typeof createService>> | undefined;
    try {
      service = await createService({ dataDir: store.directory });
      const origin = `http://127.0.0.1:${service.port}`;
      const token = service.token;
      const request = (path: string, body?: unknown) => fetch(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const initialSearch = await request(`/api/search?q=${phrase}`);
      assert.equal(initialSearch.status, 200);
      const results = searchResultsSchema.parse(await initialSearch.json());
      assert.deepEqual(results.map(result => result.target), [child, sibling].map(chat => ({ kind: 'chat', chatId: chat.id, messageId: chat.messages[0]?.id })));

      const content = 'Please use this retained attachment again';
      const siblingContent = 'Explain the retained attachment in this sibling';
      const [allowed, siblingAllowed] = await Promise.all([
        request(`/api/chats/${child.id}/messages`, { content, context: { page: 'chat' }, attachmentIds: [attachmentId] }),
        request(`/api/chats/${sibling.id}/messages`, { content: siblingContent, context: { page: 'chat' }, attachmentIds: [attachmentId] }),
      ]);
      // The unavailable provider fails after authorization and persistence.
      assert.equal(allowed.status, 500);
      assert.equal(siblingAllowed.status, 500);
      const afterSend = await Store.open(store.directory);
      const savedChild = afterSend.state.chats.find(chat => chat.id === child.id);
      assert.ok(savedChild);
      assert.equal(savedChild.messages.length, child.messages.length + 1);
      assert.equal(savedChild.messages.at(-1)?.content, content);
      assert.deepEqual(savedChild.messages.at(-1)?.attachmentIds, [attachmentId]);
      const savedSibling = afterSend.state.chats.find(chat => chat.id === sibling.id);
      assert.ok(savedSibling);
      assert.equal(savedSibling.messages.length, sibling.messages.length + 1);
      assert.equal(savedSibling.messages.at(-1)?.content, siblingContent);
      assert.deepEqual(savedSibling.messages.at(-1)?.attachmentIds, [attachmentId]);
      assert.equal(afterSend.state.chats.find(chat => chat.id === parent.id)?.deletedAt, now);

      const denied = await request(`/api/chats/${unrelated.id}/messages`, { content: 'Reuse another chat attachment', context: { page: 'chat' }, attachmentIds: [attachmentId] });
      assert.equal(denied.status, 409);
      const afterDenial = await Store.open(store.directory);
      assert.deepEqual(afterDenial.state.chats.find(chat => chat.id === unrelated.id)?.messages, unrelated.messages);
      const afterRetry = await request(`/api/search?q=${phrase}`);
      assert.deepEqual(searchResultsSchema.parse(await afterRetry.json()).map(result => result.target), results.map(result => result.target));

      assert.equal((await request(`/api/chats/${child.id}/archive`, {})).status, 200);
      const liveSibling = await request(`/api/search?q=${phrase}`);
      assert.deepEqual(searchResultsSchema.parse(await liveSibling.json()).map(result => result.target), [{ kind: 'chat', chatId: sibling.id, messageId: sibling.messages[0]?.id }]);
      assert.equal((await request(`/api/chats/${sibling.id}/archive`, {})).status, 200);
      const deletedOnly = await request(`/api/search?q=${phrase}`);
      assert.equal(deletedOnly.status, 200);
      assert.deepEqual(searchResultsSchema.parse(await deletedOnly.json()), []);
    } finally {
      try { await service?.close(); }
      finally {
        if (previousBinary === undefined) delete process.env.CENTRE_CODEX_BIN;
        else process.env.CENTRE_CODEX_BIN = previousBinary;
      }
    }
  });
});
