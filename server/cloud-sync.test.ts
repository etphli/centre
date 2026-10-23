import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { createCloudTestHarness } from '../cloud/test-support';
import { cloudChangesSchema, cloudMutationSchema, cloudRecordSchema } from '../shared/cloud';
import { attemptSchema, assistantMemorySchema, chatSchema, memorySchema, resourceSchema, snapshotSchema, messageSchema } from '../shared/schema';
import { studySessionSchema, weeklyStudyGoalSchema } from '../shared/study-log';
import { canShareChatAttachment } from '../shared/chat-lineage';
import { cloudAttachmentSchema } from '../shared/cloud-entities';
import { AttachmentStore } from './attachments';
import { CloudSync } from './cloud-sync';
import { chronologicalAttempts, compareAttempts } from '../shared/attempt-comparison';
import type { CredentialName, Credentials } from './credentials';
import { Store, writeStateFile } from './store';
import { StudyLogService } from './study-log';
import { SearchIndex } from './search-index';
import { interactiveResourceProgressId, interactiveResourceProgressSchema } from '../shared/checklist-progress';

const instant = '2026-10-22T00:00:00.000Z';
type Harness = Awaited<ReturnType<typeof createCloudTestHarness>>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const journalSchema = z.object({ cursor: z.string(), outbox: z.array(cloudMutationSchema), shadow: z.record(z.string(), cloudRecordSchema), conflicts: z.record(z.string(), cloudRecordSchema), materialized: z.array(z.string()) });
async function journal(directory: string) { return journalSchema.parse(JSON.parse(await readFile(join(directory, 'cloud-sync.json'), 'utf8'))); }
async function backend(t: TestContext) {
  const cloud = await createCloudTestHarness();
  t.after(() => cloud.db.sqlite.close());
  return cloud;
}
async function device(t: TestContext, cloud: Harness, fetcher: Fetcher = cloud.fetch, onImportedCommit?: () => void, onImportedSync?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'centre-cloud-test-'));
  const values = new Map<CredentialName, string>();
  const credentials: Pick<Credentials, 'get' | 'set'> = {
    async get(name) { return values.get(name) ?? ''; },
    async set(name, value) { values.set(name, value); },
  };
  const store = await Store.open(directory), attachments = new AttachmentStore(directory);
  const sync = await CloudSync.open(store, credentials, attachments, fetcher, onImportedCommit, onImportedSync);
  t.after(async () => { await sync.close(); await rm(directory, { recursive: true, force: true }); });
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

test('the deployed address defaults without signing in or enabling sync and preserves a saved address', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-cloud-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await Store.open(directory), attachments = new AttachmentStore(directory);
  const credentials: Pick<Credentials, 'get' | 'set'> = { get: async () => '', set: async () => {} };
  let requests = 0;
  const fetcher: Fetcher = async () => { requests++; throw new Error('Opening local study must not contact cloud.'); };
  const first = await CloudSync.open(store, credentials, attachments, fetcher);
  try {
    const status = await first.status();
    assert.equal(status.baseUrl, 'https://centre-cloud.etphli.workers.dev');
    assert.equal(status.authenticated, false);
    assert.equal(status.enabled, false);
    await first.configure('https://private-centre.example');
  } finally { await first.close(); }
  const restored = await CloudSync.open(store, credentials, attachments, fetcher);
  try {
    assert.equal((await restored.status()).baseUrl, 'https://private-centre.example');
    assert.equal((await restored.status()).enabled, false);
    assert.equal(requests, 0);
  } finally { await restored.close(); }
});

test('explicit import backs up existing study data and roundtrips portable records across persisted devices', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.credentials.set('organatoApiKey', 'secret-organato-key');
  const attemptId = randomUUID(), learnerMemoryId = randomUUID();
  await a.store.update(state => {
    state.resources.push(resource()); state.chats.push(chat());
    state.chatFolders.push({ id: 'folder', name: 'Maths', sortOrder: 1, collapsed: true });
    state.topics.push({ id: 'topic', subjectId: 'maths', name: 'Algebra', description: 'Polynomials' });
    state.attempts.push(attemptSchema.parse({ id: attemptId, resourceId: 'notes', answers: { q: 'x' }, result: { score: 1, total: 1, feedback: [] }, createdAt: instant }));
    state.memories.push(memorySchema.parse({ id: 'review', subjectId: null, topicId: null, resourceId: 'notes', question: 'Factor?', note: 'Review signs', createdAt: instant, nextReviewAt: instant }));
    state.assistantMemories.push(assistantMemorySchema.parse({ id: learnerMemoryId, key: 'learning', content: 'Use worked examples', createdAt: instant, updatedAt: instant }));
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
  const session = studySessionSchema.parse({ schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: instant, updatedAt: instant, deletedAt: null, subjectId: null, taskId: null, title: 'Maths', notes: '', timeZone: 'Australia/Sydney', source: 'timer', targetMinutes: 30, segments: [], state: { kind: 'running', since: instant, checkpointAt: '2026-10-22T00:00:15.000Z', lastActivityAt: instant, confirmedAt: instant } });
  await seed(cloud, a, 'studySession', session.id, session);
  await a.sync.sync();
  const reopened = await reopen(a), recovered = reopened.store.state.studyLog.sessions[0];
  assert.deepEqual(recovered?.state, { kind: 'paused', reason: 'recovery' });
  assert.deepEqual(recovered?.segments, [{ start: instant, end: '2026-10-22T00:00:15.000Z' }]);
  assert.equal(recovered?.revision, 2);
  assert.equal(recovered?.targetMinutes, 30);
  const persisted = await journal(a.directory);
  assert.ok(persisted.outbox.some(row => row.kind === 'studySession' && row.id === session.id));
  assert.equal((await reopened.sync.sync()).error, null);
  const remote = (await changes(cloud, reopened)).find(row => row.kind === 'studySession');
  assert.deepEqual(remote?.data?.state, { kind: 'paused', reason: 'recovery' });
  assert.equal(remote?.data?.targetMinutes, 30);
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

test('cloud attachment hydration refreshes local search after two-device sync', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const bytes = Buffer.from('searchablecloudattachmenttoken');
  const attachment = await a.attachments.upload({ name: 'cloud-notes.txt', mimeType: 'text/plain', data: bytes.toString('base64') });
  await a.store.update(state => { state.chats.push(chat([attachment.id])); });
  assert.equal((await a.sync.enableImport()).error, null);

  let searchIndex: SearchIndex | undefined;
  let bStore: Store | undefined;
  let bAttachments: AttachmentStore | undefined;
  let prehydrationMiss = false;
  let failMetadataOnce = true;
  let postHydrationRefreshes = 0;
  let prematureRefreshes = 0;
  let archiveImportExpected = false;
  let hiddenAtImportedCommit = false;
  const b = await device(t, cloud, async (input, init) => {
    const url = new URL(input);
    if (url.pathname === `/v1/attachments/${attachment.id}` && init?.method === 'GET') {
      if (!prehydrationMiss) {
        assert.ok(searchIndex && bStore);
        await searchIndex.rebuild(bStore.state);
        assert.deepEqual(searchIndex.search('searchablecloudattachmenttoken'), []);
        prehydrationMiss = true;
      }
      if (failMetadataOnce) {
        failMetadataOnce = false;
        throw new Error('Interrupted attachment metadata download');
      }
    }
    return cloud.fetch(input, init);
  }, () => {
    assert.ok(searchIndex && bStore);
    searchIndex.refreshVisibility(bStore.state);
    if (archiveImportExpected && searchIndex.search('searchablecloudattachmenttoken').length === 0) hiddenAtImportedCommit = true;
  }, () => {
    const refresh = (async () => {
      assert.ok(searchIndex && bStore && bAttachments);
      let hydrated = true;
      try {
        await bAttachments.exportContent(attachment.id);
      } catch (error) {
        if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error;
        hydrated = false;
      }
      if (hydrated) postHydrationRefreshes++;
      else {
        prematureRefreshes++;
      }
      await searchIndex.rebuild(bStore.state);
    })();
    return refresh;
  });
  bStore = b.store;
  bAttachments = b.attachments;
  searchIndex = new SearchIndex(b.attachments);

  assert.match((await b.sync.enableImport()).error ?? '', /Interrupted attachment metadata download/);
  assert.equal(postHydrationRefreshes, 0);
  assert.equal(prematureRefreshes, 0);
  assert.equal((await b.sync.sync()).error, null);
  assert.deepEqual((await b.attachments.exportContent(attachment.id)).bytes, bytes);
  assert.equal(prehydrationMiss, true);
  assert.equal(prematureRefreshes, 0);
  assert.equal(postHydrationRefreshes, 1, 'many imported Store commits should coalesce into one post-hydration refresh');
  assert.equal(searchIndex.search('searchablecloudattachmenttoken').length, 1, 'completed cloud sync must make hydrated attachment text searchable');

  const archivedAt = '2026-10-22T00:05:00.000Z';
  await a.store.update(state => {
    const chatToArchive = state.chats.find(value => value.id === 'chat');
    assert.ok(chatToArchive);
    chatToArchive.deletedAt = archivedAt;
    chatToArchive.updatedAt = archivedAt;
  });
  assert.equal((await a.sync.sync()).error, null);
  archiveImportExpected = true;
  assert.equal((await b.sync.sync()).error, null);
  assert.equal(hiddenAtImportedCommit, true, 'the visibility maps must hide an archived chat as soon as its Store commit lands');
  assert.deepEqual(searchIndex.search('searchablecloudattachmenttoken'), [], 'a remote archive must disappear from indexed search after sync');
});

test('keeping a conflicting cloud message awaits attachment hydration and search refresh', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.store.update(state => { state.chats.push(chat()); });
  assert.equal((await a.sync.enableImport()).error, null);

  let searchIndex: SearchIndex | undefined;
  let bStore: Store | undefined;
  let bAttachments: AttachmentStore | undefined;
  let cloudAttachmentId: string | undefined;
  let refreshedWithCloudAttachment = false;
  const b = await device(t, cloud, cloud.fetch, () => {
    assert.ok(searchIndex && bStore);
    searchIndex.refreshVisibility(bStore.state);
  }, async () => {
    assert.ok(searchIndex && bStore && bAttachments);
    if (cloudAttachmentId && bStore.state.chats.some(value => value.messages.some(message => message.attachmentIds.includes(cloudAttachmentId!)))) {
      await bAttachments.exportContent(cloudAttachmentId);
      refreshedWithCloudAttachment = true;
    }
    await searchIndex.rebuild(bStore.state);
  });
  bStore = b.store;
  bAttachments = b.attachments;
  searchIndex = new SearchIndex(b.attachments);
  await searchIndex.rebuild(b.store.state);
  assert.equal((await b.sync.enableImport()).error, null);

  const bytes = Buffer.from('keptcloudattachmentsearchtoken');
  const attachment = await a.attachments.upload({ name: 'kept-cloud-notes.txt', mimeType: 'text/plain', data: bytes.toString('base64') });
  cloudAttachmentId = attachment.id;
  await a.store.update(state => {
    const message = state.chats.find(value => value.id === 'chat')?.messages.find(value => value.id === 'message');
    assert.ok(message);
    message.content = 'Cloud version with an attachment';
    message.attachmentIds = [attachment.id];
  });
  await b.store.update(state => {
    const message = state.chats.find(value => value.id === 'chat')?.messages.find(value => value.id === 'message');
    assert.ok(message);
    message.content = 'Conflicting local version';
  });

  assert.equal((await a.sync.sync()).error, null);
  const conflict = await b.sync.sync();
  assert.ok(conflict.conflicts.some(value => value.kind === 'message' && value.id === 'message'));
  assert.equal((await b.sync.resolve('message', 'message', 'cloud')).error, null);
  assert.deepEqual((await b.attachments.exportContent(attachment.id)).bytes, bytes);
  assert.equal(refreshedWithCloudAttachment, true, 'Keep cloud must wait for the attachment sidecar before rebuilding search');
  assert.equal(searchIndex.search('keptcloudattachmentsearchtoken').length, 1);
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
  const resolved = await reopened.sync.sync();
  assert.equal(resolved.error, null);
  assert.deepEqual(resolved.conflicts, []);
  const remoteGoals = (await changes(cloud, reopened)).filter(value => value.kind === 'studyGoal' && !value.deleted);
  assert.equal(remoteGoals.length, 1);
  assert.equal(remoteGoals[0]?.id, first.id);
  assert.equal(remoteGoals[0]?.data?.targetMinutes, 240);
  assert.equal(reopened.store.state.studyLog.goals.length, 1);
  assert.equal(reopened.store.state.studyLog.goals[0]?.id, first.id);
  assert.equal((await a.sync.sync()).error, null);
  assert.equal(a.store.state.studyLog.goals[0]?.targetMinutes, 240);
});

test('failed state writes do not acknowledge remote imports and deferred messages materialize once on retry', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  assert.equal((await a.sync.enableImport()).error, null);
  let failResource = true, failDeferred = false;
  const store = await Store.open(a.directory, async (directory, content) => {
    const proposed = snapshotSchema.parse(JSON.parse(content));
    if (failResource && proposed.resources.some(value => value.id === 'write-failure-resource')) {
      failResource = false;
      throw new Error('Injected resource persistence failure');
    }
    if (failDeferred && proposed.chats.some(value => value.id === 'write-failure-chat' && value.messages.some(message => message.id === 'write-failure-message'))) {
      failDeferred = false;
      throw new Error('Injected deferred-message persistence failure');
    }
    await writeStateFile(directory, content);
  });
  const sync = await CloudSync.open(store, a.credentials, a.attachments, a.fetcher);
  const initialJournal = await journal(a.directory);
  const initialStateFile = await readFile(join(a.directory, 'state.json'), 'utf8');
  await seed(cloud, a, 'resource', 'write-failure-resource', resource('write-failure-resource'));
  assert.match((await sync.sync()).error ?? '', /Injected resource persistence failure/);
  assert.equal(store.state.resources.length, 0);
  assert.equal(await readFile(join(a.directory, 'state.json'), 'utf8'), initialStateFile);
  const failedJournal = await journal(a.directory);
  assert.equal(failedJournal.cursor, initialJournal.cursor);
  assert.deepEqual(failedJournal.shadow, initialJournal.shadow);
  assert.deepEqual(failedJournal.materialized, initialJournal.materialized);
  assert.equal((await sync.sync()).error, null);
  assert.equal(store.state.resources.filter(value => value.id === 'write-failure-resource').length, 1);
  assert.equal((await Store.open(a.directory)).state.resources.filter(value => value.id === 'write-failure-resource').length, 1);
  await seed(cloud, a, 'message', 'write-failure-message', { id: 'write-failure-message', chatId: 'write-failure-chat', role: 'assistant', content: 'Deferred import survives a failed write', createdAt: instant, responseDurationMs: null, resourceIds: [], attachmentIds: [], requestContext: null });
  assert.equal((await sync.sync()).error, null);
  const deferredJournal = await journal(a.directory);
  assert.ok(deferredJournal.shadow['message:write-failure-message']);
  assert.ok(!deferredJournal.materialized.includes('message:write-failure-message'));
  await seed(cloud, a, 'chat', 'write-failure-chat', { id: 'write-failure-chat', title: 'Deferred chat', createdAt: instant, updatedAt: instant, deletedAt: null, pinnedAt: null, folderId: null, sortOrder: 0, modelSelection: null, lineage: { schemaVersion: 1, kind: 'root' } });
  failDeferred = true;
  assert.match((await sync.sync()).error ?? '', /Injected deferred-message persistence failure/);
  assert.deepEqual(store.state.chats.find(value => value.id === 'write-failure-chat')?.messages, []);
  assert.deepEqual((await Store.open(a.directory)).state.chats.find(value => value.id === 'write-failure-chat')?.messages, []);
  const interrupted = await journal(a.directory);
  assert.equal(interrupted.cursor, deferredJournal.cursor);
  assert.ok(!interrupted.materialized.includes('message:write-failure-message'));
  assert.equal((await sync.sync()).error, null);
  assert.equal((await sync.sync()).error, null);
  const localMessages = store.state.chats.find(value => value.id === 'write-failure-chat')?.messages;
  const diskMessages = (await Store.open(a.directory)).state.chats.find(value => value.id === 'write-failure-chat')?.messages;
  assert.ok(localMessages);
  assert.equal(localMessages.length, 1);
  assert.equal(localMessages[0]?.content, 'Deferred import survives a failed write');
  assert.deepEqual(diskMessages, localMessages);
  assert.equal((await journal(a.directory)).materialized.filter(key => key === 'message:write-failure-message').length, 1);
});

test('a local study entry queued during cloud persistence preserves both sessions on disk', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  assert.equal((await a.sync.enableImport()).error, null);
  const remoteId = randomUUID(), localId = randomUUID();
  let queued = false;
  let localWrite: Promise<unknown> | undefined;
  let service: StudyLogService | undefined;
  const store = await Store.open(a.directory, async (directory, content) => {
    const proposed = snapshotSchema.parse(JSON.parse(content));
    if (!queued && proposed.studyLog.sessions.some(value => value.id === remoteId)) {
      queued = true;
      assert.ok(service);
      localWrite = service.route('POST', '/api/study-log/sessions', {
        id: localId, subjectId: null, taskId: null, title: 'Concurrent local study', notes: '', timeZone: 'Australia/Sydney',
        segments: [{ start: '2026-10-22T01:00:00.000Z', end: '2026-10-22T01:15:00.000Z' }],
      });
    }
    await writeStateFile(directory, content);
  });
  service = new StudyLogService(store, () => Date.parse('2026-10-22T02:00:00.000Z'));
  const sync = await CloudSync.open(store, a.credentials, a.attachments, a.fetcher);
  const remote = studySessionSchema.parse({
    schemaVersion: 1, id: remoteId, revision: 1, createdAt: instant, updatedAt: instant, deletedAt: null,
    subjectId: null, taskId: null, title: 'Imported cloud study', notes: '', timeZone: 'Australia/Sydney', source: 'manual',
    segments: [{ start: instant, end: '2026-10-22T00:15:00.000Z' }], state: { kind: 'completed' },
  });
  await seed(cloud, a, 'studySession', remoteId, remote);
  assert.equal((await sync.sync()).error, null);
  assert.ok(localWrite);
  await localWrite;
  const expectedIds = [remoteId, localId].sort();
  assert.deepEqual(store.state.studyLog.sessions.map(value => value.id).sort(), expectedIds);
  const reopened = await Store.open(a.directory);
  assert.deepEqual(reopened.state.studyLog.sessions, store.state.studyLog.sessions);
  assert.equal((await sync.sync()).error, null);
  assert.deepEqual((await changes(cloud, a)).filter(value => value.kind === 'studySession' && !value.deleted).map(value => value.id).sort(), expectedIds);
});

test('direct resource edits during an awaited import write remain local and require conflict resolution', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.store.update(state => { state.resources.push(resource()); });
  await a.sync.enableImport();
  const b = await device(t, cloud); await b.sync.enableImport();
  await b.store.update(state => { state.resources[0]!.content = 'Remote content awaiting persistence'; });
  assert.equal((await b.sync.sync()).error, null);
  let inject = true;
  let retained: ReturnType<typeof resource> | undefined;
  let queuedSave: Promise<void> | undefined;
  const store = await Store.open(a.directory, async (directory, content) => {
    const proposed = snapshotSchema.parse(JSON.parse(content));
    if (inject && proposed.resources.some(value => value.content === 'Remote content awaiting persistence')) {
      inject = false;
      assert.ok(retained);
      retained.content = 'Direct local edit during awaited writer';
      queuedSave = store.save();
    }
    await writeStateFile(directory, content);
  });
  retained = store.state.resources[0];
  assert.ok(retained);
  const sync = await CloudSync.open(store, a.credentials, a.attachments, a.fetcher);
  t.after(() => sync.close());
  const result = await sync.sync();
  assert.ok(queuedSave);
  await queuedSave;
  assert.deepEqual(result.conflicts.map(({ kind, id }) => ({ kind, id })), [{ kind: 'resource', id: 'notes' }]);
  assert.equal(store.state.resources[0], retained);
  assert.equal(retained.content, 'Direct local edit during awaited writer');
  assert.equal((await Store.open(a.directory)).state.resources[0]?.content, retained.content);
  assert.equal((await changes(cloud, b)).find(value => value.kind === 'resource')?.data?.content, 'Remote content awaiting persistence');
  await sync.resolve('resource', 'notes', 'local');
  assert.equal((await sync.sync()).error, null);
  assert.equal((await changes(cloud, b)).find(value => value.kind === 'resource')?.data?.content, retained.content);
});

test('a retained chat reference survives a remote title import and saves a later assistant message', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  await a.store.update(state => { state.chats.push(chat()); });
  await a.sync.enableImport();
  const retained = a.store.state.chats[0];
  assert.ok(retained);
  const b = await device(t, cloud); await b.sync.enableImport();
  await b.store.update(state => { state.chats[0]!.title = 'Cloud title for retained chat'; });
  assert.equal((await b.sync.sync()).error, null);
  const imported = await a.sync.sync();
  assert.equal(imported.error, null);
  assert.deepEqual(imported.conflicts, []);
  assert.equal(a.store.state.chats[0], retained);
  assert.equal(retained.title, 'Cloud title for retained chat');
  assert.equal(retained.codexThreadId, 'private-cli-thread');
  assert.equal(retained.activity[0]?.text, 'private terminal activity');
  retained.messages.push(messageSchema.parse({ id: 'retained-reference-assistant', role: 'assistant', content: 'Assistant completed through its retained chat reference', createdAt: '2026-10-22T00:01:00.000Z' }));
  await a.store.save();
  await a.sync.close();
  assert.equal(a.store.state.chats[0]?.messages.filter(value => value.id === 'retained-reference-assistant').length, 1);
  assert.equal((await Store.open(a.directory)).state.chats[0]?.messages.find(value => value.id === 'retained-reference-assistant')?.content, 'Assistant completed through its retained chat reference');
  const savedJournal = await journal(a.directory);
  assert.ok(savedJournal.outbox.some(value => value.kind === 'message' && value.id === 'retained-reference-assistant'));
  const reopened = await reopen(a);
  assert.equal((await reopened.sync.sync()).error, null);
  assert.equal((await changes(cloud, reopened)).find(value => value.kind === 'message' && value.id === 'retained-reference-assistant')?.data?.content, 'Assistant completed through its retained chat reference');
});

test('removing the only attachment message cancels an interrupted stage and releases quota after restart', async t => {
  const cloud = await backend(t);
  let loseChunkResponse = true, loseCancellationResponse = false;
  const a = await device(t, cloud, async (input, init) => {
    const response = await cloud.fetch(input, init);
    if (loseChunkResponse && /\/chunks\/0$/.test(new URL(input).pathname) && init?.method === 'PUT') {
      loseChunkResponse = false;
      assert.equal(response.status, 200);
      throw new Error('Chunk response lost after storage');
    }
    if (loseCancellationResponse && new URL(input).pathname === '/v1/records' && init?.method === 'POST') {
      const mutation = cloudMutationSchema.parse(JSON.parse(String(init.body)));
      if (mutation.kind === 'attachment' && mutation.deleted) {
        loseCancellationResponse = false;
        assert.equal(response.status, 200);
        throw new Error('Cancellation response lost after storage');
      }
    }
    return response;
  });
  const bytes = Buffer.from('Cancel this abandoned attachment stage');
  const attachment = await a.attachments.upload({ name: 'abandoned.txt', mimeType: 'text/plain', data: bytes.toString('base64') });
  await a.store.update(state => { state.chats.push(chat([attachment.id])); });
  assert.match((await a.sync.enableImport()).error ?? '', /Chunk response lost after storage/);
  const workspaceId = (await a.sync.status()).workspaceId;
  assert.ok(workspaceId);
  assert.equal(cloud.db.sqlite.prepare('SELECT complete FROM centre_attachment WHERE workspace=? AND id=?').get(workspaceId, attachment.id)?.complete, 0);
  assert.equal(cloud.db.sqlite.prepare('SELECT attachment_bytes FROM centre_workspace_usage WHERE workspace=?').get(workspaceId)?.attachment_bytes, bytes.length);
  const readStages = async () => z.object({ uploads: z.record(z.string(), z.object({ mutationId: z.string(), cancelMutationId: z.string().optional() })), downloads: z.array(z.string()) }).parse(JSON.parse(await readFile(join(a.directory, 'cloud-sync.json'), 'utf8')));
  assert.ok((await readStages()).uploads[attachment.id]);
  await a.store.update(state => { state.chats[0]!.messages = []; });
  loseCancellationResponse = true;
  assert.match((await a.sync.sync()).error ?? '', /Cancellation response lost after storage/);
  const interrupted = await readStages();
  const cancellationId = interrupted.uploads[attachment.id]?.cancelMutationId;
  assert.ok(cancellationId);
  await a.sync.close();
  const reopened = await reopen(a);
  assert.equal((await reopened.sync.sync()).error, null);
  assert.equal((await reopened.sync.sync()).pending, 0);
  assert.deepEqual((await readStages()).uploads, {});
  assert.deepEqual((await readStages()).downloads, []);
  assert.deepEqual(reopened.store.state.chats[0]?.messages, []);
  const remote = (await changes(cloud, reopened)).find(value => value.kind === 'attachment' && value.id === attachment.id);
  assert.equal(remote?.deleted, true);
  assert.equal(remote?.version, 1);
  assert.equal(cloud.db.sqlite.prepare('SELECT count(*) AS count FROM centre_mutation WHERE workspace=? AND mutation_id=?').get(workspaceId, cancellationId)?.count, 1);
  const stage = cloud.db.sqlite.prepare('SELECT complete,size FROM centre_attachment WHERE workspace=? AND id=?').get(workspaceId, attachment.id);
  assert.equal(stage?.complete, 0);
  assert.equal(stage?.size, 0);
  assert.equal(cloud.db.sqlite.prepare('SELECT attachment_bytes FROM centre_workspace_usage WHERE workspace=?').get(workspaceId)?.attachment_bytes, 0);
  assert.equal(cloud.db.sqlite.prepare('SELECT count(*) AS count FROM centre_chunk WHERE workspace=? AND id=?').get(workspaceId, attachment.id)?.count, 0);
  await assert.rejects(reopened.attachments.exportContent(attachment.id), /deleted/);
});

test('two-device checklist conflicts keep domain revisions independent of transport versions', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const documentRevision = 'a'.repeat(64);
  const id = await interactiveResourceProgressId('checklist-resource', documentRevision);
  const initial = interactiveResourceProgressSchema.parse({ schemaVersion: 1, id, revision: 1, resourceId: 'checklist-resource', documentRevision, checkedItemIds: [], createdAt: instant, updatedAt: instant, deletedAt: null });
  await a.store.update(state => {
    state.resources.push(resource('checklist-resource'));
    state.interactiveResourceProgress.push(initial);
  });
  assert.equal((await a.sync.enableImport()).error, null);
  const b = await device(t, cloud);
  assert.equal((await b.sync.enableImport()).error, null);
  assert.deepEqual(b.store.state.interactiveResourceProgress, [initial]);
  // A timestamp-only retry makes no domain edit and must accept canonical timestamps.
  const progress = a.store.state.interactiveResourceProgress[0];
  assert.ok(progress);
  progress.updatedAt = '2026-10-22T00:00:30.000Z';
  await a.store.save();
  const retry = await a.sync.sync();
  assert.equal(retry.error, null);
  assert.equal(retry.pending, 0);
  assert.equal(a.store.state.interactiveResourceProgress[0]?.updatedAt, instant);
  assert.equal((await Store.open(a.directory)).state.interactiveResourceProgress[0]?.updatedAt, instant);
  const retriedRecord = (await changes(cloud, a)).find(value => value.kind === 'interactiveProgress' && value.id === id);
  assert.ok(retriedRecord);
  assert.equal(retriedRecord.version, 2);
  assert.equal(retriedRecord.data?.revision, 1);
  assert.equal(retriedRecord.data?.updatedAt, instant);
  assert.equal((await b.sync.sync()).error, null);
  await a.store.update(state => {
    const progress = state.interactiveResourceProgress[0];
    assert.ok(progress);
    progress.revision = 2; progress.checkedItemIds = ['alpha']; progress.updatedAt = '2026-10-22T00:01:00.000Z';
  });
  await b.store.update(state => {
    const progress = state.interactiveResourceProgress[0];
    assert.ok(progress);
    progress.revision = 2; progress.checkedItemIds = ['beta']; progress.updatedAt = '2026-10-22T00:02:00.000Z';
  });
  assert.equal((await a.sync.sync()).error, null);
  const conflicted = await b.sync.sync();
  assert.deepEqual(conflicted.conflicts.map(({ kind, id: valueId }) => ({ kind, id: valueId })), [{ kind: 'interactiveProgress', id }]);
  assert.deepEqual(b.store.state.interactiveResourceProgress[0]?.checkedItemIds, ['beta']);
  assert.equal(b.store.state.interactiveResourceProgress[0]?.revision, 2);
  await b.sync.resolve('interactiveProgress', id, 'local');
  assert.equal(b.store.state.interactiveResourceProgress[0]?.revision, 3);
  const resolved = await b.sync.sync();
  assert.equal(resolved.error, null);
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(resolved.pending, 0);
  const remote = (await changes(cloud, b)).find(value => value.kind === 'interactiveProgress' && value.id === id);
  assert.ok(remote);
  assert.equal(remote.version, 4);
  assert.equal(remote.data?.revision, 3);
  assert.deepEqual(remote.data?.checkedItemIds, ['beta']);
  assert.equal((await a.sync.sync()).error, null);
  const reopened = await reopen(b);
  assert.deepEqual(reopened.store.state.interactiveResourceProgress, a.store.state.interactiveResourceProgress);
  assert.deepEqual(reopened.store.state.interactiveResourceProgress[0], remote.data);
  assert.equal((await reopened.sync.sync()).pending, 0);
});

test('keeping a local running timer conflict preserves its lease until normal restart recovery', async t => {
  const cloud = await backend(t), a = await device(t, cloud);
  const id = randomUUID();
  const initial = studySessionSchema.parse({
    schemaVersion: 1, id, revision: 1, createdAt: instant, updatedAt: instant, deletedAt: null,
    subjectId: null, taskId: null, title: 'Local running timer', notes: '', timeZone: 'Australia/Sydney', source: 'timer',
    segments: [{ start: '2026-10-21T23:59:00.000Z', end: '2026-10-21T23:59:30.000Z' }],
    state: { kind: 'running', since: instant, checkpointAt: '2026-10-22T00:00:15.000Z', lastActivityAt: instant, confirmedAt: instant },
  });
  await a.store.update(state => { state.studyLog.sessions.push(initial); });
  assert.equal((await a.sync.enableImport()).error, null);
  const b = await device(t, cloud);
  assert.equal((await b.sync.enableImport()).error, null);
  assert.deepEqual(b.store.state.studyLog.sessions[0]?.state, { kind: 'paused', reason: 'recovery' });
  await b.store.update(state => {
    const session = state.studyLog.sessions[0];
    assert.ok(session);
    session.revision = 3; session.title = 'Remote timer edit'; session.updatedAt = '2026-10-22T00:01:00.000Z';
  });
  // The import recovery and subsequent edit are separate durable mutations.
  assert.equal((await b.sync.sync()).error, null);
  assert.equal((await b.sync.sync()).error, null);
  assert.equal((await changes(cloud, b)).find(value => value.kind === 'studySession' && value.id === id)?.data?.revision, 3);
  await a.store.update(state => {
    const session = state.studyLog.sessions[0];
    assert.ok(session);
    session.revision = 2; session.updatedAt = '2026-10-22T00:00:30.000Z';
    session.state = { kind: 'running', since: instant, checkpointAt: '2026-10-22T00:00:30.000Z', lastActivityAt: '2026-10-22T00:00:30.000Z', confirmedAt: instant };
  });
  const local = structuredClone(a.store.state.studyLog.sessions[0]);
  assert.ok(local);
  const conflicted = await a.sync.sync();
  assert.deepEqual(conflicted.conflicts.map(({ kind, id: valueId }) => ({ kind, id: valueId })), [{ kind: 'studySession', id }]);
  assert.deepEqual(a.store.state.studyLog.sessions[0], local);
  await a.sync.resolve('studySession', id, 'local');
  const resolved = a.store.state.studyLog.sessions[0];
  assert.ok(resolved);
  assert.equal(resolved.revision, 4);
  assert.deepEqual(resolved.state, local.state);
  assert.deepEqual(resolved.segments, local.segments);
  const reopened = await reopen(a);
  assert.equal(reopened.store.state.studyLog.sessions[0]?.revision, 4);
  assert.deepEqual(reopened.store.state.studyLog.sessions[0]?.state, local.state);
  assert.deepEqual(reopened.store.state.studyLog.sessions[0]?.segments, local.segments);
  const service = new StudyLogService(reopened.store, () => Date.parse('2026-10-22T00:02:00.000Z'));
  const recovered = await service.recover(true);
  assert.deepEqual(recovered.sessions[0]?.state, { kind: 'paused', reason: 'recovery' });
  assert.equal(recovered.sessions[0]?.revision, 5);
  assert.deepEqual(recovered.sessions[0]?.segments, [...local.segments, { start: instant, end: '2026-10-22T00:00:30.000Z' }]);
  await reopened.sync.close();
});

test('read-only comparison survives independent D1 sync, offline restart, resource deletion and account isolation', async t => {
  const cloud = await backend(t), alice = await device(t,cloud);
  const records = [0,1].map((score,index) => attemptSchema.parse({id:randomUUID(),sourceDraftId:randomUUID(),resourceId:'history-quiz',answers:{q:'saved answer'},createdAt:`2026-10-2${index+1}T00:00:00.000Z`,result:{score,total:1,feedback:[{questionId:'q',concept:'Fractions',score,maxScore:1,feedback:'Retained grade',needsReview:!score}]}}));
  await alice.store.update(state => { state.resources.push(resource('history-quiz')); state.attempts.push(...records); });
  assert.equal((await alice.sync.enableImport()).error,null);
  const phone = await device(t,cloud);
  assert.equal((await phone.sync.enableImport()).error,null);
  assert.deepEqual(chronologicalAttempts(phone.store.state.attempts),records);
  const first = records[0], second = records[1];
  assert.ok(first && second);
  const expected = compareAttempts(first,second);
  assert.equal(expected?.percentagePointChange,100);
  assert.equal(expected?.questions[0]?.change,'improved');
  const savedJournal = await readFile(join(phone.directory,'cloud-sync.json'),'utf8');
  assert.deepEqual(compareAttempts(first,second),expected);
  assert.equal(await readFile(join(phone.directory,'cloud-sync.json'),'utf8'),savedJournal,'Comparison never enqueues writes.');
  await alice.store.update(state => { const item = state.resources.find(item=>item.id==='history-quiz'); if(item)item.deletedAt=instant; });
  assert.equal((await alice.sync.sync()).error,null);
  assert.equal((await phone.sync.sync()).error,null);
  assert.deepEqual(phone.store.state.attempts,records);
  await phone.sync.close();
  const offline = await Store.open(phone.directory);
  assert.deepEqual(offline.state.attempts,records,'Restart reads saved history without a network connection.');
  assert.deepEqual(compareAttempts(offline.state.attempts[0],offline.state.attempts[1]),expected);
  const bob = await cloud.login('bob');
  const response = await cloud.call('/v1/changes?cursor=0','GET',undefined,String(bob.token));
  assert.equal(response.status,200);
  assert.deepEqual(cloudChangesSchema.parse(response.value).records,[],'Another account receives no history records.');
  const aliceHistory = (await changes(cloud,alice)).filter(record => record.kind === 'practice.attempt');
  assert.deepEqual(new Set(aliceHistory.map(record => record.id)),new Set(records.map(record => record.id)));
  const persisted = await Store.open(alice.directory);
  assert.deepEqual(persisted.state.attempts,records,'No content was overwritten by comparing or deleting the resource.');
});

test('a simulated 24-hour mounted idle desktop and second device retain sync and foreground capacity', async t => {
  const cloud = await backend(t), start = Date.parse(instant);
  let time = start, bootstraps = 0, desktopPulls = 0;
  t.mock.method(Date,'now',()=>time);
  const a = await device(t,cloud,async (input,init) => {
    const path = new URL(input).pathname;
    if (path==='/v1/bootstrap') bootstraps++;
    if (path==='/v1/changes') desktopPulls++;
    return cloud.fetch(input,init);
  });
  const b = await device(t,cloud);
  assert.equal((await a.sync.enableImport()).error,null);
  assert.equal((await b.sync.enableImport()).error,null);
  for (let tick=1; tick<2880; tick++) {
    time = start+tick*30000; cloud.setTime(time);
    // Another device explicitly syncs every 30s, and makes useful hourly edits.
    if (tick%120===0) await b.store.update(state=>{state.resources.push(resource(`hour-${tick/120}`));});
    assert.equal((await b.sync.sync()).error,null,`second device tick ${tick}`);
    assert.equal((await a.sync.poll()).error,null,`desktop tick ${tick}`);
    if (tick%10===0) assert.equal((await cloud.call('/v1/devices','GET',undefined,await b.credentials.get('cloudSession'))).status,200);
  }
  assert.equal((await a.sync.sync()).error,null);
  assert.equal(a.store.state.resources.length,23);
  assert.equal(bootstraps,1,'session binding is verified once per process and token');
  assert.ok(desktopPulls<500,`idle desktop made ${desktopPulls} pulls`);
  // A local edit bypasses the current idle deadline on the next timer tick.
  await a.store.update(state=>{state.resources.push(resource('local-after-idle'));});
  assert.equal((await a.sync.poll()).pending,0);
  assert.ok((await changes(cloud,a)).some(record=>record.id==='local-after-idle'));
  // Revocation still fails immediately despite the cached binding.
  const token = await a.credentials.get('cloudSession');
  const account = await cloud.call('/v1/bootstrap','GET',undefined,token);
  assert.equal((await cloud.call('/v1/devices/revoke','POST',{deviceId:account.value.deviceId},token)).status,200);
  assert.match((await a.sync.sync()).error ?? '',/expired|revoked/);
});

test('background idle backoff preserves immediate explicit recovery after an offline failure', async t => {
  const cloud = await backend(t); let offline = false, requests = 0;
  let time = Date.parse(instant); t.mock.method(Date,'now',()=>time);
  const a = await device(t,cloud,async(input,init)=>{
    requests++; if (offline) throw new Error('Fixture offline'); return cloud.fetch(input,init);
  });
  await a.sync.enableImport();
  offline = true; time+=60000; cloud.setTime(time);
  assert.match((await a.sync.poll()).error ?? '',/Fixture offline/);
  const failedRequests = requests;
  time+=30000; cloud.setTime(time); await a.sync.poll();
  assert.equal(requests,failedRequests,'offline timer also backs off');
  offline = false;
  assert.equal((await a.sync.sync()).error,null,'explicit recovery does not wait for the timer');
});
