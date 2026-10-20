import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorCatalog, connectorReadSchema, googleConnectors, googleScopes } from '../shared/connectors';
import { validateRequest } from '../electron/security';
import { Store } from './store';
import { Connectors, googleReadRequest } from './connectors';
import { ConnectedFiles, fileSnapshot } from './connected-files';
import { GoogleLogin } from './google';
import type { CredentialName } from './credentials';

function memoryCredentials() {
  const values = new Map<CredentialName, string>();
  return { values, get: async (name: CredentialName) => values.get(name) ?? '', set: async (name: CredentialName, value: string) => { if (value) values.set(name, value); else values.delete(name); } };
}
const docsFixture = { title: 'Biology revision', revisionId: 'revision-1', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Cells contain a nucleus.\n' } }] } }] } };

test('all offered Google connectors have bounded read requests and no Gmail scopes', () => {
  assert.equal(connectorCatalog.length, 15);
  assert.ok(googleConnectors.every(item => item.scopes.length && item.scopes.every(scope => !scope.includes('gmail') && !scope.includes('mail.google'))));
  assert.ok(googleScopes('google-docs', true).includes('https://www.googleapis.com/auth/documents'));
  for (const item of googleConnectors) for (const action of ['list', 'read']) {
    const request = googleReadRequest(connectorReadSchema.parse({ connector: item.id, action, resourceId: 'test', query: "a' \\ file" }));
    assert.equal(request.url.protocol, 'https:');
    assert.match(request.url.hostname, /(^|\.)googleapis\.com$/);
  }
  assert.throws(() => googleReadRequest(connectorReadSchema.parse({ connector: 'google-docs', action: 'read' })), /resource ID/);
  assert.throws(() => googleReadRequest(connectorReadSchema.parse({ connector: 'google-docs', action: 'read', resourceId: '..' })), /valid resource ID/);
  validateRequest('GET', '/api/connectors', undefined);
  for (const path of ['google/start', 'notion', 'cancel', 'disconnect']) validateRequest('POST', `/api/connectors/${path}`, {});
  validateRequest('POST', '/api/resources/file/refresh', {});
});

test('connected file snapshots preserve document text, grid cells and slide content', () => {
  assert.match(fileSnapshot('google-docs', 'doc', docsFixture).content, /Cells contain a nucleus/);
  const sheet = fileSnapshot('google-sheets', 'sheet', { properties: { title: 'Marks' }, sheets: [{ properties: { title: 'Term 1' }, data: [{ rowData: [{ values: [{ formattedValue: 'Biology' }, { effectiveValue: { numberValue: 95 } }] }] }] }] });
  assert.deepEqual(sheet.connectedFile.sheets[0]?.rows, [['Biology', '95']]);
  const deck = fileSnapshot('google-slides', 'slides', { title: 'Cells', slides: [{ objectId: 'slide-1', pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Cell structure' } }] } } }] }] });
  assert.equal(deck.connectedFile.slides[0]?.text, 'Cell structure');
});

test('reads, edits, refresh, disconnect and reload preserve one resource and keep tokens out of state', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-connectors-'));
  const store = await Store.open(directory); const credentials = memoryCredentials();
  const connectors = new Connectors(store, credentials); const files = new ConnectedFiles(store, connectors);
  let doc = structuredClone(docsFixture); let writes = 0; let failReads = false; let failWrites = false; let refreshes = 0;
  credentials.values.set('connector-google-docs', JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_at: 0, client_id: 'test-client', expires_in: 3600 }));
  store.state.settings.connectors.push({ id: 'google-docs', connected: true, canEdit: false, account: 'student@example.com', connectedAt: new Date().toISOString() });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') { refreshes++; return Response.json({ access_token: 'new-private-access', expires_in: 3600 }); }
    if (target.includes(':batchUpdate')) {
      writes++; if (failWrites) return Response.json({}, { status: 409 });
      const body = JSON.parse(String(init?.body)); assert.equal(body.writeControl.requiredRevisionId, 'revision-1');
      doc = { ...doc, revisionId: 'revision-2', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Cells contain DNA.\n' } }] } }] } };
      return Response.json({ replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
    }
    if (target.includes('/documents/')) { if (failReads) return Response.json({}, { status: 503 }); return Response.json(doc); }
    throw new Error(`Unexpected request: ${target}`);
  });
  try {
    const first = await files.read({ connector: 'google-docs', action: 'read', resourceId: 'doc-1' });
    assert.ok('resource' in first); assert.equal(first.resource.title, 'Biology revision'); assert.equal(refreshes, 1);
    const edit = { connector: 'google-docs', fileId: 'doc-1', revision: 'revision-1', confirmedByUser: true, find: 'a nucleus', replacement: 'DNA' };
    await assert.rejects(files.edit(edit), /Enable editing/); assert.equal(writes, 0);
    const status = store.state.settings.connectors[0]; assert.ok(status); status.canEdit = true;
    const updated = await files.edit(edit); assert.ok('resource' in updated); assert.equal(updated.resource.id, first.resource.id); assert.match(updated.resource.content, /DNA/); assert.equal(writes, 1); assert.equal(store.state.resources.length, 1);
    failWrites = true; await assert.rejects(files.edit(edit), /409/); assert.equal(writes, 2); failWrites = false;
    failReads = true; await assert.rejects(files.edit(edit), /edit was saved to Google/); assert.equal(writes, 3); failReads = false;
    const refreshed = await files.refresh(first.resource.id); assert.equal(refreshed.id, first.resource.id);
    const serialized = await readFile(join(directory, 'state.json'), 'utf8'); assert.ok(!serialized.includes('private-access')); assert.ok(!serialized.includes('private-refresh'));
    const restored = await Store.open(directory); assert.equal(restored.state.resources[0]?.connectedFile?.fileId, 'doc-1');
    await connectors.disconnect('google-docs'); assert.ok(!credentials.values.has('connector-google-docs')); assert.equal(store.state.resources.length, 1);
    await assert.rejects(files.refresh(first.resource.id), /Connect this service/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Notion validates the token before storage and exposes shared content as data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-notion-'));
  const credentials = memoryCredentials(); const store = await Store.open(directory); const connectors = new Connectors(store, credentials);
  let allowed = false;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Notion-Version'), '2025-09-03');
    if (!allowed) return Response.json({}, { status: 401 });
    return Response.json(String(url).endsWith('/users/me') ? { bot: { workspace_name: 'Study' } } : { results: [{ id: 'page-1' }] });
  });
  try {
    await assert.rejects(connectors.connectNotion('secret-token'), /401/); assert.equal(credentials.values.size, 0);
    allowed = true; await connectors.connectNotion('secret-token');
    assert.equal(connectors.status().connectors.find(item => item.id === 'notion')?.account, 'Study');
    const result = await connectors.read({ connector: 'notion', action: 'list', query: 'Biology' }); assert.deepEqual(result.untrustedContent, { results: [{ id: 'page-1' }] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Google connector OAuth uses PKCE, validates state and only records granted scopes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'centre-google-oauth-'));
  const store = await Store.open(directory); store.state.settings.googleClientId = 'fixture-client';
  const credentials = memoryCredentials(); const google = new GoogleLogin(store, credentials);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    if (String(url).includes('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: `openid email profile ${googleScopes('google-docs', true).join(' ')}` });
    return Response.json({ name: 'Student', email: 'student@example.com', email_verified: true });
  });
  try {
    const auth = new URL((await google.start('google-docs', true)).url);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.ok(!auth.searchParams.get('scope')?.includes('gmail'));
    const callback = new URL(auth.searchParams.get('redirect_uri') ?? ''); callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400); assert.equal(credentials.values.size, 0);
    callback.searchParams.set('state', auth.searchParams.get('state') ?? ''); callback.searchParams.set('code', 'fixture');
    assert.equal((await fetch(callback)).status, 200); assert.ok(credentials.values.has('connector-google-docs'));
    assert.equal(store.state.settings.connectors[0]?.canEdit, true); assert.equal(store.state.settings.account, null);
  } finally { google.close(); await rm(directory, { recursive: true, force: true }); }
});
