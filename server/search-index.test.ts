import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentSchema, attachmentSchema, chatSchema, eventSchema, resourceSchema, snapshotSchema, subjectSchema, topicSchema, type Chat, type Resource } from '../shared/schema';
import { MAX_SEARCH_RESULTS, MAX_SEARCH_SNIPPET_LENGTH, searchResultsSchema } from '../shared/search';
import { AttachmentStore } from './attachments';
import { ConnectedFiles, fileSnapshot } from './connected-files';
import { createService } from './index';
import { SearchIndex } from './search-index';
import { emptySnapshot, Store } from './store';

const now = '2026-10-22T00:00:00.000Z';
function resource(id: string, fields: Partial<Resource> = {}): Resource {
  return resourceSchema.parse({ id, title: 'Study notes', kind: 'notes', subjectId: null, topicId: null, content: '', createdAt: now, updatedAt: now, ...fields });
}
function chat(id: string, attachmentIds: string[] = [], fields: Partial<Chat> = {}): Chat {
  return chatSchema.parse({ id, title: 'Study conversation', createdAt: now, updatedAt: now, messages: [{ id: `${id}-message`, role: 'user', content: 'Study material', attachmentIds, createdAt: now }], ...fields });
}
const noAttachments = { workspaceId: 'test-workspace', searchText: async () => undefined };

// Generate a real one-page PDF, matching the attachment extraction fixture.
function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

test('search finds resource body, each question field, and flashcard fronts and backs with precise targets', async () => {
  const snapshot = emptySnapshot();
  snapshot.resources.push(
    resource('notes', { content: 'A body-only phrase describes mitochondrial inheritance.' }),
    resource('quiz', { kind: 'quiz', questions: [{ id: 'question', responseType: 'short_response', choices: [], marks: 1, prompt: 'Explain osmotic pressure', answer: 'Semipermeable membrane', explanation: 'Water follows a concentration gradient' }] }),
    resource('cards', { kind: 'flashcards', questions: [{ id: 'card', responseType: 'short_response', choices: [], marks: 1, prompt: 'Anterior anatomy', answer: 'Posterior anatomy', explanation: '' }] }),
    resource('paper', { kind: 'test', questions: [{ id: 'paper-question', responseType: 'short_response', choices: [], marks: 1, prompt: 'Describe nuclear division', answer: 'Mitosis', explanation: 'Chromosomes separate during anaphase' }] }),
  );
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  assert.deepEqual(index.search('mitochondrial inheritance')[0]?.target, { kind: 'resource', resourceId: 'notes' });
  for (const query of ['osmotic pressure', 'semipermeable membrane', 'concentration gradient']) {
    assert.deepEqual(index.search(query)[0]?.target, { kind: 'resource', resourceId: 'quiz', questionId: 'question' });
  }
  assert.equal(index.search('anterior')[0]?.sourceLabel, 'Flashcard front');
  assert.equal(index.search('posterior')[0]?.sourceLabel, 'Flashcard back');
  assert.deepEqual(index.search('posterior')[0]?.target, { kind: 'resource', resourceId: 'cards', questionId: 'card' });
  assert.equal(index.search('nuclear division')[0]?.sourceLabel, 'Test prompt');
  assert.equal(index.search('anaphase')[0]?.sourceLabel, 'Test explanation');
  assert.ok(index.search('quiz').some(result => result.id === 'resource:quiz'));
});

test('existing subject, topic, chat, event and assignment search remains available', async () => {
  const snapshot = emptySnapshot();
  snapshot.subjects.push(subjectSchema.parse({ id: 'subject', name: 'Biology', shortName: 'Bio', color: '#8ea6e8' }));
  snapshot.topics.push(topicSchema.parse({ id: 'topic', subjectId: 'subject', name: 'Cell structure', description: 'Cytoplasm' }));
  snapshot.chats.push(chat('conversation', [], { title: 'Revision lounge', messages: [{ id: 'message', role: 'user', content: 'Explain covalent bonding', createdAt: now, resourceIds: [], attachmentIds: [], activity: [], responseDurationMs: null }] }));
  snapshot.events.push(eventSchema.parse({ id: 'event', title: 'Lab practical', date: '2026-10-23', notes: 'Bring a microscope' }));
  snapshot.assignments.push(assignmentSchema.parse({ id: 'work', title: 'Cell revision task', kind: 'work', subjectId: 'subject', dueDate: null, status: 'assigned', version: 1 }));
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  assert.equal(index.search('bio')[0]?.kind, 'subject');
  assert.equal(index.search('cytoplasm')[0]?.kind, 'topic');
  assert.equal(index.search('revision lounge')[0]?.kind, 'chat');
  assert.deepEqual(index.search('covalent')[0]?.target, { kind: 'chat', chatId: 'conversation', messageId: 'message' });
  assert.equal(index.search('microscope')[0]?.kind, 'event');
  assert.equal(index.search('revision task')[0]?.kind, 'assignment');
});

test('multiword queries require every term and rank contiguous phrases first', async () => {
  const snapshot = emptySnapshot();
  snapshot.resources.push(
    resource('separated', { content: 'electron follows a longer transport pathway' }),
    resource('phrase', { content: 'electron transport takes place here' }),
    resource('partial', { content: 'electron alone' }),
  );
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  assert.deepEqual(index.search('electron transport').map(result => result.id), ['resource:phrase', 'resource:separated']);
});

test('saved connected snapshots are searchable and refresh replaces stale body terms', async () => {
  const snapshot = emptySnapshot();
  const saved = resource('sheet', fileSnapshot('google-sheets', 'sheet-id', { properties: { title: 'Results' }, sheets: [{ properties: { title: 'Term one' }, data: [{ rowData: [{ values: [{ formattedValue: 'chloroplast specimen' }] }] }] }] }));
  snapshot.resources.push(saved);
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  assert.equal(index.search('chloroplast specimen')[0]?.id, 'resource:sheet');
  Object.assign(saved, fileSnapshot('google-sheets', 'sheet-id', { properties: { title: 'Results' }, sheets: [{ properties: { title: 'Term two' }, data: [{ rowData: [{ values: [{ formattedValue: 'ribosome revision' }] }] }] }] }));
  await index.rebuild(snapshot);
  assert.deepEqual(index.search('chloroplast'), []);
  assert.equal(index.search('ribosome')[0]?.id, 'resource:sheet');
  saved.content = 'edited nucleus';
  saved.connectedFile = null;
  await index.rebuild(snapshot);
  assert.deepEqual(index.search('ribosome'), []);
  assert.equal(index.search('nucleus')[0]?.id, 'resource:sheet');
});

test('real PDF and DOCX extraction sidecars survive missing original bytes and queries perform no attachment reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-search-attachments-'));
  try {
    const attachments = new AttachmentStore(directory);
    const pdf = await attachments.upload({ name: 'worksheet.pdf', mimeType: 'application/pdf', data: pdfWithText('photosynthesis electron transport').toString('base64') });
    const docx = await attachments.upload({ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: (await readFile(new URL('../node_modules/mammoth/test/test-data/single-paragraph.docx', import.meta.url))).toString('base64') });
    await attachments.upload({ name: 'orphan.txt', mimeType: 'text/plain', data: Buffer.from('orphanclassified').toString('base64') });
    await rm(join(directory, 'attachments', `${pdf.id}.pdf`));
    await rm(join(directory, 'attachments', `${docx.id}.docx`));
    const snapshot = emptySnapshot();
    snapshot.chats.push(chat('documents', [pdf.id, docx.id]));
    let reads = 0;
    const restarted = new AttachmentStore(directory);
    const index = new SearchIndex({ workspaceId: 'test-workspace', searchText: async id => { reads += 1; return restarted.searchText(id); } });
    await index.rebuild(snapshot);
    assert.equal(reads, 2);
    assert.deepEqual(index.search('orphanclassified'), []);
    assert.equal(index.search('photosynthesis electron')[0]?.sourceLabel, 'PDF attachment');
    assert.equal(index.search('Walking on imported air')[0]?.sourceLabel, 'DOCX attachment');
    assert.deepEqual(index.search('photosynthesis')[0]?.target, { kind: 'chat', chatId: 'documents', messageId: 'documents-message' });
    for (let count = 0; count < 50; count++) index.search('electron');
    assert.equal(reads, 2);
    await index.rebuild(snapshot);
    assert.equal(reads, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deleted owners and attachment IDs shared with archived chats never leak', async () => {
  const snapshot = emptySnapshot();
  snapshot.resources.push(resource('deleted', { content: 'resourceclassified', deletedAt: now }));
  const hiddenFile = '11111111-1111-4111-8111-111111111111';
  const ambiguousFile = '22222222-2222-4222-8222-222222222222';
  snapshot.chats.push(chat('hidden', [hiddenFile], { title: 'chatclassified', deletedAt: now }), chat('active', [ambiguousFile]), chat('archived', [ambiguousFile], { deletedAt: now }));
  const loaded: string[] = [];
  const index = new SearchIndex({ workspaceId: 'test-workspace', searchText: async id => { loaded.push(id); return { attachment: { id, name: 'private.txt', mimeType: 'text/plain', size: 20 }, text: 'attachmentclassified' }; } });
  await index.rebuild(snapshot);
  assert.deepEqual(loaded, []);
  for (const query of ['resourceclassified', 'chatclassified', 'attachmentclassified']) assert.deepEqual(index.search(query), []);
  const deleted = snapshot.resources[0];
  const hidden = snapshot.chats[0];
  assert.ok(deleted && hidden);
  deleted.deletedAt = null;
  hidden.deletedAt = null;
  await index.rebuild(snapshot);
  assert.equal(index.search('resourceclassified').length, 1);
  assert.equal(index.search('chatclassified').length, 1);
  assert.deepEqual(loaded, [hiddenFile]);
  assert.deepEqual(index.search('attachmentclassified')[0]?.target, { kind: 'chat', chatId: 'hidden', messageId: 'hidden-message' });
});

test('Unicode, punctuation, empty queries, and bounded snippets retain valid highlight offsets at library scale', async () => {
  const snapshot = emptySnapshot();
  snapshot.resources.push(resource('unicode', { content: 'Café: naïve βιολογία, 東京! E=mc².' }));
  for (let count = 0; count < 240; count++) snapshot.resources.push(resource(`large-${count}`, { content: `${'context '.repeat(100)}${'evidence '.repeat(60)}${'ending '.repeat(100)}` }));
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  assert.equal(index.search('CAFE, naive!')[0]?.id, 'resource:unicode');
  assert.equal(index.search('βιολογία 東京')[0]?.id, 'resource:unicode');
  assert.deepEqual(index.search('   !?'), []);
  assert.deepEqual(index.search('unindexedword'), []);
  const results = searchResultsSchema.parse(index.search('evidence'));
  assert.equal(results.length, MAX_SEARCH_RESULTS);
  for (const result of results) {
    assert.ok(result.snippet.length <= MAX_SEARCH_SNIPPET_LENGTH);
    assert.ok(result.highlights.length > 0 && result.highlights.length <= 24);
    for (const [start, end] of result.highlights) {
      assert.ok(start >= 0 && start < end && end <= result.snippet.length);
      assert.equal(result.snippet.slice(start, end), 'evidence');
    }
  }
});

test('search API authenticates, bounds input, rebuilds on archive and restore, and loads saved data on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-search-api-'));
  const originalBinary = process.env.CENTRE_CODEX_BIN;
  process.env.CENTRE_CODEX_BIN = join(directory, 'missing-codex');
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  try {
    const store = await Store.open(directory);
    store.state.resources.push(resource('persisted', { content: 'persistedresourceterm' }));
    store.state.chats.push(chat('persisted-chat', [], { title: 'persistedchatterm' }));
    await store.save();
    service = await createService({ dataDir: directory });
    const request = async (path: string, method = 'GET') => {
      assert.ok(service);
      return fetch(`http://127.0.0.1:${service.port}/api${path}`, { method, headers: { Authorization: `Bearer ${service.token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    };
    const search = async (query: string) => {
      const response = await request(`/search?q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200);
      return searchResultsSchema.parse(await response.json());
    };
    assert.equal((await fetch(`http://127.0.0.1:${service.port}/api/search?q=persistedresourceterm`)).status, 401);
    for (const path of ['/search', '/search?q=one&q=two', '/search?q=one&extra=two', `/search?q=${'x'.repeat(161)}`]) assert.equal((await request(path)).status, 400);
    assert.deepEqual(await search(''), []);
    assert.equal((await search('persistedresourceterm')).length, 1);
    assert.equal((await search('persistedchatterm')).length, 1);
    for (const [path, term] of [['resources/persisted', 'persistedresourceterm'], ['chats/persisted-chat', 'persistedchatterm']]) {
      assert.equal((await request(`/${path}/archive`, 'POST')).status, 200);
      assert.deepEqual(await search(term ?? ''), []);
      assert.equal((await request(`/${path}/restore`, 'POST')).status, 200);
      assert.equal((await search(term ?? '')).length, 1);
    }
    await service.close();
    service = await createService({ dataDir: directory });
    assert.equal((await search('persistedresourceterm')).length, 1);
    assert.equal((await search('persistedchatterm')).length, 1);
  } finally {
    await service?.close();
    if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalBinary;
    await rm(directory, { recursive: true, force: true });
  }
});


test('new message attachments survive AI failure and retries while rejecting other active or deleted chat owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-search-message-'));
  const originalBinary = process.env.CENTRE_CODEX_BIN;
  process.env.CENTRE_CODEX_BIN = join(directory, 'missing-codex');
  const service = await createService({ dataDir: directory });
  const request = async (path: string, method = 'GET', body?: unknown) => {
    return fetch(`http://127.0.0.1:${service.port}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${service.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const search = async (query: string) => {
    const response = await request(`/search?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200);
    return searchResultsSchema.parse(await response.json());
  };
  try {
    const uploadedResponse = await request('/attachments', 'POST', { name: 'lesson.txt', mimeType: 'text/plain', data: Buffer.from('attachmentonlysecret mitochondria').toString('base64') });
    assert.equal(uploadedResponse.status, 200);
    const attachment = attachmentSchema.parse(await uploadedResponse.json());
    assert.deepEqual(await search('attachmentonlysecret'), []);
    const owner = chatSchema.parse(await (await request('/chats', 'POST', { title: 'Original lesson' })).json());
    const other = chatSchema.parse(await (await request('/chats', 'POST', { title: 'Other lesson' })).json());
    const send = (chatId: string, content: string) => request(`/chats/${chatId}/messages`, 'POST', { content, context: { page: 'chat' }, attachmentIds: [attachment.id] });
    assert.equal((await send(owner.id, 'persistedmessagephrase')).status, 500);
    const persisted = snapshotSchema.parse(await (await request('/state')).json());
    const message = persisted.chats.find(candidate => candidate.id === owner.id)?.messages.find(candidate => candidate.role === 'user');
    assert.ok(message);
    assert.deepEqual(message.attachmentIds, [attachment.id]);
    assert.equal(message.content, 'persistedmessagephrase');
    const expectedTarget = { kind: 'chat', chatId: owner.id, messageId: message.id };
    assert.deepEqual((await search('attachmentonlysecret')).map(result => result.target), [expectedTarget]);
    assert.deepEqual((await search('persistedmessagephrase')).map(result => result.target), [expectedTarget]);
    assert.equal((await send(owner.id, 'retrymessagephrase')).status, 500);
    assert.equal((await search('retrymessagephrase')).length, 1);
    assert.deepEqual((await search('attachmentonlysecret')).map(result => result.target), [expectedTarget]);
    assert.equal((await send(other.id, 'rejectedactivephrase')).status, 409);
    assert.deepEqual(await search('rejectedactivephrase'), []);
    assert.deepEqual((await search('attachmentonlysecret')).map(result => result.target), [expectedTarget]);
    assert.equal((await request(`/chats/${owner.id}/archive`, 'POST', {})).status, 200);
    assert.deepEqual(await search('attachmentonlysecret'), []);
    assert.deepEqual(await search('persistedmessagephrase'), []);
    assert.equal((await send(other.id, 'rejectedarchivedphrase')).status, 409);
    assert.deepEqual(await search('rejectedarchivedphrase'), []);
    assert.deepEqual(await search('attachmentonlysecret'), []);
    const afterRejection = snapshotSchema.parse(await (await request('/state')).json());
    assert.deepEqual(afterRejection.chats.find(candidate => candidate.id === other.id)?.messages, []);
    assert.equal((await request(`/chats/${owner.id}/restore`, 'POST', {})).status, 200);
    assert.deepEqual((await search('attachmentonlysecret')).map(result => result.target), [expectedTarget]);
    assert.deepEqual((await search('persistedmessagephrase')).map(result => result.target), [expectedTarget]);
    const reopened = await Store.open(directory);
    assert.deepEqual(reopened.state.chats.find(candidate => candidate.id === owner.id)?.messages[0]?.attachmentIds, [attachment.id]);
  } finally {
    await service.close();
    if (originalBinary === undefined) delete process.env.CENTRE_CODEX_BIN; else process.env.CENTRE_CODEX_BIN = originalBinary;
    await rm(directory, { recursive: true, force: true });
  }
});

test('240 resources and 120 twenty-KB attachment sidecars remain queryable without repeated file reads', async context => {
  const snapshot = emptySnapshot();
  for (let count = 0; count < 240; count++) snapshot.resources.push(resource(`benchmark-${count}`, { content: `${'resourcebenchmark '.repeat(200)}resourceunique${count}` }));
  const attachmentIds = Array.from({ length: 120 }, () => randomUUID());
  for (const [index, id] of attachmentIds.entries()) snapshot.chats.push(chat(`benchmark-chat-${index}`, [id]));
  const text = `attachmentbenchmark ${'extracted '.repeat(2048)}`.slice(0, 20 * 1024);
  assert.equal(Buffer.byteLength(text), 20 * 1024);
  let reads = 0;
  const index = new SearchIndex({ workspaceId: 'test-workspace', searchText: async id => {
    reads += 1;
    return { attachment: { id, name: `${id}.txt`, mimeType: 'text/plain', size: Buffer.byteLength(text) }, text };
  } });
  const rebuildStart = performance.now();
  await index.rebuild(snapshot);
  const rebuildMs = performance.now() - rebuildStart;
  assert.equal(reads, 120);
  const queryStart = performance.now();
  for (let query = 0; query < 200; query++) {
    const results = index.search(query % 2 === 0 ? 'attachmentbenchmark' : 'resourcebenchmark');
    assert.equal(results.length, MAX_SEARCH_RESULTS);
    assert.equal(results[0]?.kind, query % 2 === 0 ? 'attachment' : 'resource');
  }
  const queryMs = performance.now() - queryStart;
  assert.equal(reads, 120);
  await index.rebuild(snapshot);
  assert.equal(reads, 120);
  context.diagnostic(`240 resources + 120 attachments of ${Buffer.byteLength(text)} bytes: rebuild ${rebuildMs.toFixed(1)} ms; 200 queries ${queryMs.toFixed(1)} ms; attachment reads ${reads} during rebuild, 0 during queries`);
});

test('composed and decomposed accents match each other and retain complete original highlight spans', async () => {
  const snapshot = emptySnapshot();
  const composed = 'naïve';
  const decomposed = 'nai\u0308ve';
  snapshot.resources.push(resource('composed', { content: `An ${composed} approach` }), resource('decomposed', { content: `An ${decomposed} approach` }));
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  for (const query of [composed, decomposed, 'naive']) {
    const results = searchResultsSchema.parse(index.search(query));
    assert.deepEqual(new Set(results.map(result => result.id)), new Set(['resource:composed', 'resource:decomposed']));
    for (const result of results) {
      const original = result.id === 'resource:composed' ? composed : decomposed;
      assert.equal(result.highlights.length, 1);
      for (const [start, end] of result.highlights) {
        assert.ok(start >= 0 && end <= result.snippet.length);
        assert.equal(result.snippet.slice(start, end), original);
      }
    }
  }
});

test('long display labels and combined context fit the response schema without truncating searchable text', async () => {
  const snapshot = emptySnapshot();
  const longTitle = (length: number, ending: string) => `${'a'.repeat(length - ending.length - 1)} ${ending}`;
  snapshot.subjects.push({ id: 'long-subject', name: 'S'.repeat(190), shortName: null, color: '#fff', icon: 'book' });
  snapshot.topics.push({ id: 'long-topic', subjectId: 'long-subject', name: 'T'.repeat(190), description: '' });
  snapshot.resources.push(
    resource('label301', { title: longTitle(301, 'titleendingone'), subjectId: 'long-subject', topicId: 'long-topic', content: 'bodyendingone' }),
    resource('label500', { title: longTitle(500, 'titleendingtwo'), subjectId: 'long-subject', topicId: 'long-topic', content: 'bodyendingtwo' }),
  );
  assert.equal(snapshot.resources[0]?.title.length, 301);
  assert.equal(snapshot.resources[1]?.title.length, 500);
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  for (const [query, id] of [['titleendingone', 'resource:label301'], ['bodyendingone', 'resource:label301'], ['titleendingtwo', 'resource:label500'], ['bodyendingtwo', 'resource:label500']]) {
    assert.ok(query && id);
    const results = searchResultsSchema.parse(index.search(query));
    assert.equal(results.length, 1);
    const result = results[0];
    assert.ok(result);
    assert.equal(result.id, id);
    assert.ok(result.label.length <= 300);
    assert.ok(result.contextLabel && result.contextLabel.length <= 300);
    assert.ok(result.snippet.includes(query));
  }
});

test('the final query token matches a longer indexed word and highlights that original word', async () => {
  const snapshot = emptySnapshot();
  snapshot.resources.push(resource('mitochondrial', { content: 'Study mitochondrial inheritance today' }), resource('unrelated', { content: 'Study mitosis tomorrow' }));
  const index = new SearchIndex(noAttachments);
  await index.rebuild(snapshot);
  for (const query of ['mitochondri', 'study mitochondri']) {
    const results = searchResultsSchema.parse(index.search(query));
    assert.deepEqual(results.map(result => result.id), ['resource:mitochondrial']);
    const result = results[0];
    assert.ok(result);
    assert.ok(result.highlights.some(([start, end]) => result.snippet.slice(start, end) === 'mitochondrial'));
  }
});

test('connected-file persistence hooks update search after reads, refreshes, and edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-search-connected-'));
  try {
    const store = await Store.open(directory);
    const index = new SearchIndex(noAttachments);
    let content = 'originalconnectedphrase';
    const files = new ConnectedFiles(store, {
      read: async () => ({ source: 'Synthetic Google Docs', untrustedContent: { title: 'Class notes', body: { textRun: { content } } } }),
      edit: async () => { content = 'editedconnectedphrase'; },
    }, index);
    const first = await files.read({ connector: 'google-docs', action: 'read', resourceId: 'class-doc' });
    assert.ok('resource' in first);
    assert.equal(index.search(content).length, 1);
    content = 'refreshedconnectedphrase';
    await files.refresh(first.resource.id);
    assert.deepEqual(index.search('originalconnectedphrase'), []);
    assert.equal(index.search(content).length, 1);
    await files.edit({ connector: 'google-docs', fileId: 'class-doc', revision: 'revision-1', confirmedByUser: true, find: 'refreshedconnectedphrase', replacement: 'editedconnectedphrase' });
    assert.deepEqual(index.search('refreshedconnectedphrase'), []);
    assert.equal(index.search('editedconnectedphrase').length, 1);
    assert.equal((await Store.open(directory)).state.resources.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deleted content disappears even while an attachment rebuild is waiting on disk', async () => {
  const snapshot = emptySnapshot();
  const hiddenResource = resource('hidden-body', { content: 'resourceprivatephrase' });
  const hiddenChat = chat('hidden-chat', [], { title: 'chatprivatephrase' });
  snapshot.resources.push(hiddenResource);
  snapshot.chats.push(hiddenChat);
  let release: (() => void) | undefined;
  const index = new SearchIndex({ workspaceId: 'test-workspace', searchText: async id => new Promise(resolve => {
    release = () => resolve({ attachment: { id, name: 'new.txt', mimeType: 'text/plain', size: 4 }, text: 'new content' });
  }) });
  await index.rebuild(snapshot);
  assert.equal(index.search('resourceprivatephrase').length, 1);
  hiddenResource.deletedAt = now;
  hiddenChat.deletedAt = now;
  snapshot.chats.push(chat('new-owner', ['33333333-3333-4333-8333-333333333333']));
  const rebuilding = index.rebuild(snapshot);
  assert.ok(release);
  assert.deepEqual(index.search('resourceprivatephrase'), []);
  assert.deepEqual(index.search('chatprivatephrase'), []);
  release();
  await rebuilding;
});
