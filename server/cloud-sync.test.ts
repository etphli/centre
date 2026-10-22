import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { createCloudTestHarness } from '../cloud/test-support';
import { cloudChangesSchema, cloudMutationSchema, cloudRecordSchema } from '../shared/cloud';
import { attemptSchema, assistantMemorySchema, chatSchema, memorySchema, resourceSchema } from '../shared/schema';
import { studySessionSchema, weeklyStudyGoalSchema } from '../shared/study-log';
import { canShareChatAttachment } from '../shared/chat-lineage';
import { cloudAttachmentSchema } from '../shared/cloud-entities';
import { AttachmentStore } from './attachments';
import { CloudSync } from './cloud-sync';
import type { CredentialName, Credentials } from './credentials';
import { Store } from './store';

const instant = '2026-10-22T00:00:00.000Z';
type Harness = Awaited<ReturnType<typeof createCloudTestHarness>>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const journalSchema = z.object({ cursor: z.string(), outbox: z.array(cloudMutationSchema), shadow: z.record(z.string(), cloudRecordSchema), conflicts: z.record(z.string(), cloudRecordSchema) });
async function journal(directory: string) { return journalSchema.parse(JSON.parse(await readFile(join(directory, 'cloud-sync.json'), 'utf8'))); }
async function backend(t: TestContext) {
  const cloud = await createCloudTestHarness();
  t.after(() => cloud.db.sqlite.close());
  return cloud;
}
async function device(t: TestContext, cloud: Harness, fetcher: Fetcher = cloud.fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'centre-cloud-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = new Map<CredentialName, string>();
  const credentials: Pick<Credentials, 'get' | 'set'> = {
    async get(name) { return values.get(name) ?? ''; },
    async set(name, value) { values.set(name, value); },
  };
  const store = await Store.open(directory), attachments = new AttachmentStore(directory);
  const sync = await CloudSync.open(store, credentials, attachments, fetcher);
  await sync.configure('https://centre.example');
  await sync.authenticate(await cloud.identity('alice'));
  return { directory, store, attachments, credentials, sync, fetcher };
}
async function reopen(d: Awaited<ReturnType<typeof device>>) {
  const store = await Store.open(d.directory);
  return { ...d, store, sync: await CloudSync.open(store, d.credentials, d.attachments, d.fetcher) };
}
async function changes(cloud: Harness, d: Awaited<ReturnType<typeof device>>) {
  const response = await cloud.call('/v1/changes?cursor=0&limit=100', 'GET', undefined, await d.credentials.get('cloudSession'));
  assert.equal(response.status, 200);
  return cloudChangesSchema.parse(response.value).records;
}
async function seed(cloud: Harness, d: Awaited<ReturnType<typeof device>>, kind: string, id: string, data: unknown) {
  const response = await cloud.call('/v1/records', 'POST', { mutationId: randomUUID(), schemaVersion: 1, expectedVersion: 0, kind, id, deleted: false, data }, await d.credentials.get('cloudSession'));
  assert.equal(response.status, 200, JSON.stringify(response.value));
}
function resource(id = 'notes') { return resourceSchema.parse({ id, subjectId: null, topicId: null, title: 'Algebra', kind: 'notes', createdAt: instant, updatedAt: instant, deletedAt: null, content: 'Factor quadratics.' }); }
function chat(attachmentIds: string[] = []) {
  return chatSchema.parse({ id: 'chat', title: 'Revision', createdAt: instant, updatedAt: instant, codexThreadId: 'private-cli-thread', folderId: 'folder', activity: [{ id: 'tool', kind: 'tool', text: 'private terminal activity', state: 'done' }], messages: [{ id: 'message', role: 'user', codexTurns: [{ turnId: 'private-cli-turn', promptMessageId: 'message' }], content: 'Explain factors', createdAt: instant, attachmentIds, resourceIds: ['notes'], activity: [{ id: 'message-tool', kind: 'tool', text: 'private message activity', state: 'done' }] }] });
}

test('explicit import backs up existing study data and roundtrips portable records across persisted devices', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.credentials.set('organatoApiKey', 'secret-organato-key');
  await a.store.update(state => {
    state.resources.push(resource()); state.chats.push(chat());
    state.chatFolders.push({ id: 'folder', name: 'Maths', sortOrder: 1, collapsed: true });
    state.topics.push({ id: 'topic', subjectId: 'maths', name: 'Algebra', description: 'Polynomials' });
    state.attempts.push(attemptSchema.parse({ id: randomUUID(), resourceId: 'notes', answers: { q: 'x' }, result: { score: 1, total: 1, feedback: [] }, createdAt: instant }));
    state.memories.push(memorySchema.parse({ id: 'review', subjectId: null, topicId: null, resourceId: 'notes', question: 'Factor?', note: 'Review signs', createdAt: instant, nextReviewAt: instant }));
    state.assistantMemories.push(assistantMemorySchema.parse({ id: randomUUID(), key: 'learning', content: 'Use worked examples', createdAt: instant, updatedAt: instant }));
    state.settings.theme = 'midnight'; state.settings.googleClientId = 'private-google-client';
    state.settings.account = { name: 'Private Account', email: 'private@example.com' };
    state.activeResponses.push({ chatId: 'chat', startedAt: 1, status: 'working' });
    state.codex = { available: true, authenticated: true, message: 'private cli status' };
  });
  assert.equal((await changes(cloud, a)).length, 0);
  const before = structuredClone(a.store.state);
  assert.equal((await a.sync.enableImport()).error, null);
  const backups = await readdir(join(a.directory, 'cloud-backups'));
  assert.equal(backups.length, 1);
  const backup = z.object({ snapshot: z.unknown() }).parse(JSON.parse(await readFile(join(a.directory, 'cloud-backups', backups[0]), 'utf8')));
  assert.deepEqual(backup.snapshot, before);
  const records = await changes(cloud, a), wire = JSON.stringify(records);
  const persistedFiles = await Promise.all(['state.json', 'cloud-sync.json'].map(name => readFile(join(a.directory, name), 'utf8')));
  for (const content of persistedFiles) {
    assert.ok(!content.includes('secret-organato-key'));
    assert.ok(!content.includes(await a.credentials.get('cloudSession')));
  }
  for (const kind of ['topic', 'resource', 'chat', 'message', 'chatFolder', 'attempt', 'reviewMemory', 'learnerMemory', 'preferences']) assert.ok(records.some(row => row.kind === kind), kind);
  for (const secret of ['secret-organato-key', 'private-google-client', 'private@example.com', 'private-cli-thread', 'private-cli-turn', 'private terminal activity', 'private message activity', 'activeResponses', 'private cli status']) assert.ok(!wire.includes(secret), secret);
  const b = await device(t, cloud);
  await b.store.update(state => { state.settings.theme = 'midnight'; });
  assert.equal((await b.sync.enableImport()).error, null);
  const reopened = await reopen(b);
  assert.deepEqual(reopened.store.state.resources, a.store.state.resources);
  assert.deepEqual(reopened.store.state.attempts, a.store.state.attempts);
  assert.deepEqual(reopened.store.state.memories, a.store.state.memories);
  assert.deepEqual(reopened.store.state.assistantMemories, a.store.state.assistantMemories);
  assert.deepEqual(reopened.store.state.chatFolders, a.store.state.chatFolders);
  assert.equal(reopened.store.state.chats[0]?.messages[0]?.content, 'Explain factors');
  assert.equal(reopened.store.state.chats[0]?.codexThreadId, null);
  assert.deepEqual(reopened.store.state.chats[0]?.messages[0]?.activity, []);
  assert.equal(reopened.store.state.settings.account, null);
  assert.equal((await reopened.sync.status()).pending, 0);
  assert.equal((await reopened.sync.sync()).error, null);
  assert.equal((await readdir(join(b.directory, 'cloud-backups'))).length, 1);
});

test('offline restart preserves mutation IDs and retries an accepted write whose response was lost once', async t => {
  const cloud = await backend(t);
  let offline = false, dropResponse = false;
  const sent: string[] = [];
  const a = await device(t, cloud, async (input, init) => {
    if (offline) throw new Error('Offline for test');
    if (new URL(input).pathname === '/v1/records' && init?.method === 'POST') {
      const mutation = cloudMutationSchema.parse(JSON.parse(String(init.body)));
      sent.push(mutation.mutationId);
      const response = await cloud.fetch(input, init);
      if (dropResponse) { dropResponse = false; throw new Error('Response lost after commit'); }
      return response;
    }
    return cloud.fetch(input, init);
  });
  await a.sync.enableImport();
  offline = true;
  await a.store.update(state => { state.resources.push(resource()); });
  assert.match((await a.sync.sync()).error ?? '', /Offline/);
  const first = await journal(a.directory);
  // The journal captures offline local writes before attempting network I/O.
  assert.equal(first.outbox.length, 1);
  const b = await reopen(a);
  assert.deepEqual((await journal(b.directory)).outbox, first.outbox);
  assert.equal(b.store.state.resources[0]?.content, 'Factor quadratics.');
  offline = false; dropResponse = true;
  assert.match((await b.sync.sync()).error ?? '', /Response lost/);
  const interrupted = await journal(b.directory);
  assert.deepEqual(interrupted.outbox.map(row => row.mutationId), first.outbox.map(row => row.mutationId));
  const c = await reopen(b);
  assert.equal((await c.sync.sync()).error, null);
  assert.equal((await c.sync.status()).pending, 0);
  const stored = (await changes(cloud, c)).filter(row => row.kind === 'resource');
  assert.equal(stored.length, 1); assert.equal(stored[0]?.version, 1);
  assert.ok(sent.includes(first.outbox[0]!.mutationId));
  assert.equal(cloud.db.sqlite.prepare("SELECT count(*) AS count FROM centre_mutation WHERE kind='resource'").get()?.count, 1);
});

test('two devices retain conflicting edits until explicit local or cloud resolution', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.store.update(state => { state.resources.push(resource()); });
  await a.sync.enableImport();
  const b = await device(t, cloud); await b.sync.enableImport();
  await a.store.update(state => { state.resources[0]!.content = 'First device'; });
  await b.store.update(state => { state.resources[0]!.content = 'Second device'; });
  await a.sync.sync();
  assert.deepEqual((await b.sync.sync()).conflicts.map(({ kind, id }) => ({ kind, id })), [{ kind: 'resource', id: 'notes' }]);
  assert.equal(b.store.state.resources[0]?.content, 'Second device');
  const reopened = await reopen(b);
  assert.equal((await reopened.sync.status()).phase, 'conflict');
  await reopened.sync.resolve('resource', 'notes', 'local'); await reopened.sync.sync();
  assert.equal((await changes(cloud, reopened)).find(row => row.kind === 'resource')?.data?.content, 'Second device');
  await a.store.update(state => { state.resources[0]!.content = 'Third edit'; });
  assert.equal((await a.sync.sync()).conflicts.length, 1);
  await a.sync.resolve('resource', 'notes', 'cloud');
  assert.equal(a.store.state.resources[0]?.content, 'Second device');
  assert.equal((await a.sync.sync()).pending, 0);
});

test('account changes stop uploads and another workspace cannot read the library', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.sync.enableImport();
  const aliceToken = await a.credentials.get('cloudSession');
  await assert.rejects(a.sync.authenticate(await cloud.identity('bob')), /another Centre cloud account/);
  assert.equal(await a.credentials.get('cloudSession'), aliceToken);
  const bob = await cloud.login('bob');
  assert.equal(typeof bob.token, 'string');
  await a.credentials.set('cloudSession', String(bob.token));
  await a.store.update(state => { state.resources.push(resource('private-alice')); });
  assert.match((await a.sync.sync()).error ?? '', /account changed/i);
  const response = await cloud.call('/v1/changes?cursor=0', 'GET', undefined, String(bob.token));
  assert.deepEqual(cloudChangesSchema.parse(response.value).records, []);
  assert.equal(cloud.db.sqlite.prepare("SELECT count(*) AS count FROM centre_record WHERE id='private-alice'").get()?.count, 0);
});

test('incoming running timers pause at their checkpoint and persist the recovery as a pending edit', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.sync.enableImport();
  const session = studySessionSchema.parse({ schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: instant, updatedAt: instant, deletedAt: null, subjectId: null, taskId: null, title: 'Maths', notes: '', timeZone: 'Australia/Sydney', source: 'timer', segments: [], state: { kind: 'running', since: instant, checkpointAt: '2026-10-22T00:00:15.000Z', lastActivityAt: instant, confirmedAt: instant } });
  await seed(cloud, a, 'studySession', session.id, session);
  await a.sync.sync();
  const reopened = await reopen(a), recovered = reopened.store.state.studyLog.sessions[0];
  assert.deepEqual(recovered?.state, { kind: 'paused', reason: 'recovery' });
  assert.deepEqual(recovered?.segments, [{ start: instant, end: '2026-10-22T00:00:15.000Z' }]);
  assert.equal(recovered?.revision, 2);
  const persisted = await journal(a.directory);
  assert.ok(persisted.outbox.some(row => row.kind === 'studySession' && row.id === session.id));
  assert.equal((await reopened.sync.sync()).error, null);
  assert.deepEqual((await changes(cloud, reopened)).find(row => row.kind === 'studySession')?.data?.state, { kind: 'paused', reason: 'recovery' });
});

test('attachments preserve IDs and bytes across devices, deferred messages and future kinds survive restart', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const bytes = Buffer.from('学'.repeat(100000));
  const attachment = await a.attachments.upload({ name: 'revision.txt', mimeType: 'text/plain', data: bytes.toString('base64') });
  await a.store.update(state => { state.chats.push(chat([attachment.id])); });
  assert.equal((await a.sync.enableImport()).error, null);
  const b = await device(t, cloud);
  assert.equal((await b.sync.enableImport()).error, null);
  assert.deepEqual((await b.attachments.exportContent(attachment.id)).bytes, bytes);
  assert.deepEqual(b.store.state.chats[0]?.messages[0]?.attachmentIds, [attachment.id]);
  await seed(cloud, a, 'message', 'early-message', { id: 'early-message', chatId: 'late-chat', role: 'assistant', content: 'Arrived first', createdAt: instant, responseDurationMs: null, resourceIds: [], attachmentIds: [], requestContext: null });
  assert.equal((await b.sync.sync()).error, null);
  assert.ok((await journal(b.directory)).shadow['message:early-message']);
  const reopened = await reopen(b);
  await seed(cloud, a, 'chat', 'late-chat', { id: 'late-chat', title: 'Later chat', createdAt: instant, updatedAt: instant, deletedAt: null, pinnedAt: null, folderId: null, sortOrder: 0, modelSelection: null, lineage: { schemaVersion: 1, kind: 'root' } });
  const workspace = (await a.sync.status()).workspaceId;
  assert.ok(workspace);
  cloud.db.sqlite.prepare("INSERT INTO centre_record(workspace,kind,id,version,cursor,updated_at,deleted,data) VALUES(?,?,?,?,?,?,?,?)").run(workspace, 'future.record', 'future-id', 1, 100000, instant, 0, JSON.stringify({ future: true }));
  assert.equal((await reopened.sync.sync()).error, null);
  assert.equal(reopened.store.state.chats.find(row => row.id === 'late-chat')?.messages[0]?.content, 'Arrived first');
  const again = await reopen(reopened);
  assert.deepEqual((await journal(again.directory)).shadow['future.record:future-id']?.data, { future: true });
  assert.deepEqual((await again.attachments.exportContent(attachment.id)).bytes, bytes);
});

test('an edit queued during the changes response survives pull as an explicit conflict', async t => {
  const cloud = await backend(t);
  let editStore: Store | undefined;
  let queueEdit = false;
  const queuedWrites: Promise<void>[] = [];
  const a = await device(t, cloud, async (input, init) => {
    const response = await cloud.fetch(input, init);
    if (queueEdit && new URL(input).pathname === '/v1/changes') {
      queueEdit = false;
      assert.ok(editStore);
      queuedWrites.push(editStore.update(() => undefined));
      queuedWrites.push(editStore.update(state => { state.resources[0]!.content = 'New local edit queued during pull'; }));
    }
    return response;
  });
  editStore = a.store;
  await a.store.update(state => { state.resources.push(resource()); });
  await a.sync.enableImport();
  const b = await device(t, cloud); await b.sync.enableImport();
  await b.store.update(state => { state.resources[0]!.content = 'Remote edit'; });
  assert.equal((await b.sync.sync()).error, null);
  queueEdit = true;
  const result = await a.sync.sync();
  await Promise.all(queuedWrites);
  assert.equal(a.store.state.resources[0]?.content, 'New local edit queued during pull');
  assert.deepEqual(result.conflicts.map(({ kind, id }) => ({ kind, id })), [{ kind: 'resource', id: 'notes' }]);
  const reopened = await reopen(a);
  assert.equal(reopened.store.state.resources[0]?.content, 'New local edit queued during pull');
  assert.deepEqual((await reopened.sync.status()).conflicts.map(({ kind, id }) => ({ kind, id })), [{ kind: 'resource', id: 'notes' }]);
  assert.equal((await changes(cloud, b)).find(row => row.kind === 'resource')?.data?.content, 'Remote edit');
});

test('a deleted local message stays deleted after repeated pulls and persists a cloud tombstone', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.store.update(state => { state.chats.push(chat()); });
  assert.equal((await a.sync.enableImport()).error, null);
  await a.store.update(state => { state.chats[0]!.messages = []; });
  assert.equal((await a.sync.sync()).error, null);
  assert.deepEqual(a.store.state.chats[0]?.messages, []);
  const reopened = await reopen(a);
  assert.equal((await reopened.sync.sync()).error, null);
  assert.deepEqual(reopened.store.state.chats[0]?.messages, []);
  const remote = (await changes(cloud, reopened)).find(row => row.kind === 'message' && row.id === 'message');
  assert.ok(remote);
  assert.equal(remote.deleted, true);
  assert.equal(remote.data, null);
  assert.equal(remote.version, 2);
});

test('an attachment tombstone clears interrupted downloads so later local writes can sync', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const attachment = await a.attachments.upload({ name: 'to-delete.txt', mimeType: 'text/plain', data: Buffer.from('Deleted after interrupted download').toString('base64') });
  await a.store.update(state => { state.chats.push(chat([attachment.id])); });
  assert.equal((await a.sync.enableImport()).error, null);
  let failMetadata = true;
  const b = await device(t, cloud, async (input, init) => {
    if (failMetadata && new URL(input).pathname === `/v1/attachments/${attachment.id}` && init?.method === 'GET') {
      failMetadata = false;
      throw new Error('Interrupted metadata download');
    }
    return cloud.fetch(input, init);
  });
  assert.match((await b.sync.enableImport()).error ?? '', /Interrupted metadata download/);
  const downloadJournal = z.object({ downloads: z.array(z.string()) }).parse(JSON.parse(await readFile(join(b.directory, 'cloud-sync.json'), 'utf8')));
  assert.deepEqual(downloadJournal.downloads, [attachment.id]);
  const tombstone = await cloud.call('/v1/records', 'POST', { mutationId: randomUUID(), schemaVersion: 1, kind: 'attachment', id: attachment.id, expectedVersion: 1, deleted: true, data: null }, await a.credentials.get('cloudSession'));
  assert.equal(tombstone.status, 200, JSON.stringify(tombstone.value));
  const reopened = await reopen(b);
  await reopened.store.update(state => { state.topics.push({ id: 'after-download', subjectId: 'maths', name: 'New local topic', description: '' }); });
  assert.equal((await reopened.sync.sync()).error, null);
  const recoveredJournal = z.object({ downloads: z.array(z.string()) }).parse(JSON.parse(await readFile(join(b.directory, 'cloud-sync.json'), 'utf8')));
  assert.deepEqual(recoveredJournal.downloads, []);
  assert.ok((await changes(cloud, reopened)).some(row => row.kind === 'topic' && row.id === 'after-download'));
  assert.equal((await reopened.sync.sync()).error, null);
  assert.equal((await reopened.sync.status()).pending, 0);
});

test('a continued chat retains attachment access through its archived parent across two devices', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const bytes = Buffer.from('The inherited source document');
  const attachment = await a.attachments.upload({ name: 'inherited.txt', mimeType: 'text/plain', data: bytes.toString('base64') });
  const parent = chatSchema.parse({
    id: 'attachment-parent', title: 'Original conversation', createdAt: instant, updatedAt: instant,
    messages: [
      { id: 'parent-user', role: 'user', content: 'Explain this document', createdAt: instant, attachmentIds: [attachment.id] },
      { id: 'parent-assistant', role: 'assistant', content: 'Here is the completed explanation', createdAt: instant },
    ],
  });
  const child = chatSchema.parse({
    id: 'attachment-child', title: 'Continued conversation', createdAt: instant, updatedAt: instant,
    lineage: { schemaVersion: 1, kind: 'branch', operation: 'continue', parentChatId: parent.id, sourceMessageId: 'parent-assistant', checkpointMessageId: 'parent-assistant', promptMessageId: null },
    messages: parent.messages.map((message, index) => ({ ...structuredClone(message), id: `child-message-${index}` })),
  });
  const unrelated = chatSchema.parse({
    id: 'attachment-unrelated', title: 'Unrelated conversation', createdAt: instant, updatedAt: instant,
    messages: [{ id: 'unrelated-guessed-file', role: 'user', content: 'Guessed attachment identifier', createdAt: instant, attachmentIds: [attachment.id] }],
  });
  await a.store.update(state => { state.chats.push(parent, child, unrelated); });
  assert.equal((await a.sync.enableImport()).error, null);
  const b = await device(t, cloud);
  assert.equal((await b.sync.enableImport()).error, null);
  assert.deepEqual((await b.attachments.exportContent(attachment.id)).bytes, bytes);
  const archivedAt = '2026-10-22T00:05:00.000Z';
  await a.store.update(state => {
    const storedParent = state.chats.find(value => value.id === parent.id);
    assert.ok(storedParent);
    storedParent.deletedAt = archivedAt;
    storedParent.updatedAt = archivedAt;
  });
  assert.equal((await a.sync.sync()).error, null);
  assert.equal((await b.sync.sync()).error, null);
  const reopened = await reopen(b);
  const retainedParent = reopened.store.state.chats.find(value => value.id === parent.id);
  assert.equal(retainedParent?.deletedAt, archivedAt);
  assert.deepEqual(retainedParent?.messages, parent.messages);
  const remoteParent = (await changes(cloud, b)).find(value => value.kind === 'chat' && value.id === parent.id);
  assert.equal(remoteParent?.deleted, false);
  assert.equal(remoteParent?.data?.deletedAt, archivedAt);
  assert.ok(remoteParent);
  const physicalDelete = await cloud.call('/v1/records', 'POST', { mutationId: randomUUID(), schemaVersion: 1, kind: 'chat', id: parent.id, expectedVersion: remoteParent.version, deleted: true, data: null }, await a.credentials.get('cloudSession'));
  assert.equal(physicalDelete.status, 409);
  assert.equal((await changes(cloud, b)).find(value => value.kind === 'chat' && value.id === parent.id)?.deleted, false);
  const workspaceId = (await reopened.sync.status()).workspaceId;
  assert.ok(workspaceId);
  const graph = reopened.store.state.chats.map(value => ({ workspaceId, chat: value }));
  const source = { workspaceId, chatId: parent.id };
  assert.equal(canShareChatAttachment(graph, attachment.id, source, { workspaceId, chatId: child.id }), true);
  assert.equal(canShareChatAttachment(graph, attachment.id, source, { workspaceId, chatId: parent.id }), false);
  assert.equal(canShareChatAttachment(graph, attachment.id, source, { workspaceId, chatId: unrelated.id }), false);
  const aliceToken = await reopened.credentials.get('cloudSession');
  const metadataPath = `/v1/attachments/${attachment.id}?chatId=${child.id}`;
  const metadata = await cloud.call(metadataPath, 'GET', undefined, aliceToken);
  assert.equal(metadata.status, 200);
  assert.equal(cloud.db.sqlite.prepare('SELECT owner_chat_id FROM centre_attachment WHERE workspace=? AND id=?').get(workspaceId, attachment.id)?.owner_chat_id, parent.id);
  const { id: _attachmentId, ...uploadMetadata } = cloudAttachmentSchema.parse(metadata.value);
  assert.equal((await cloud.call(`/v1/attachments/${attachment.id}`, 'PUT', { ...uploadMetadata, sourceChatId: unrelated.id, chatId: unrelated.id }, aliceToken)).status, 409);
  const chunk = await cloud.call(`/v1/attachments/${attachment.id}/chunks/0?chatId=${child.id}`, 'GET', undefined, aliceToken);
  assert.equal(chunk.status, 200);
  assert.deepEqual(Buffer.from(z.object({ data: z.string() }).parse(chunk.value).data, 'base64'), bytes);
  for (const chatId of [parent.id, unrelated.id]) {
    assert.equal((await cloud.call(`/v1/attachments/${attachment.id}?chatId=${chatId}`, 'GET', undefined, aliceToken)).status, 404);
    assert.equal((await cloud.call(`/v1/attachments/${attachment.id}/chunks/0?chatId=${chatId}`, 'GET', undefined, aliceToken)).status, 404);
  }
  const bob = await cloud.login('bob');
  assert.equal((await cloud.call(metadataPath, 'GET', undefined, String(bob.token))).status, 404);
  assert.equal((await cloud.call(`/v1/attachments/${attachment.id}/chunks/0?chatId=${child.id}`, 'GET', undefined, String(bob.token))).status, 404);
});

test('concurrent weekly goals require resolution and converge on one persisted goal identity', async t => {
  const cloud = await backend(t), a = await device(t, cloud), b = await device(t, cloud);
  await a.sync.enableImport(); await b.sync.enableImport();
  const first = weeklyStudyGoalSchema.parse({ schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: instant, updatedAt: instant, deletedAt: null, weekStart: '2026-10-19', timeZone: 'Australia/Sydney', targetMinutes: 120 });
  const second = weeklyStudyGoalSchema.parse({ ...first, id: randomUUID(), targetMinutes: 240 });
  await a.store.update(state => { state.studyLog.goals.push(first); });
  assert.deepEqual(b.store.state.studyLog.goals, [], 'An unsynced goal from another device must stay private');
  await b.store.update(state => { state.studyLog.goals.push(second); });
  assert.equal((await a.sync.sync()).error, null);
  const conflicted = await b.sync.sync();
  assert.deepEqual(conflicted.conflicts.map(({ kind, id }) => ({ kind, id })), [{ kind: 'studyGoal', id: second.id }]);
  assert.deepEqual(b.store.state.studyLog.goals, [second]);
  const reopened = await reopen(b);
  await reopened.sync.resolve('studyGoal', second.id, 'local');
  assert.equal((await reopened.sync.sync()).error, null);
  const remoteGoals = (await changes(cloud, reopened)).filter(value => value.kind === 'studyGoal' && !value.deleted);
  assert.equal(remoteGoals.length, 1);
  assert.equal(remoteGoals[0]?.id, first.id);
  assert.equal(remoteGoals[0]?.data?.targetMinutes, 240);
  assert.equal(reopened.store.state.studyLog.goals.length, 1);
  assert.equal(reopened.store.state.studyLog.goals[0]?.id, first.id);
  assert.equal((await a.sync.sync()).error, null);
  assert.equal(a.store.state.studyLog.goals[0]?.targetMinutes, 240);
});
