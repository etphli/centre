import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chatSchema, messageSchema } from '../shared/schema.ts';
import { projectChatForSync, projectMessageForSync } from '../shared/chat-sync.ts';
import { cloudAuthSchema, cloudChangesSchema, cloudRecordSchema } from '../shared/cloud.ts';

// Explicit opt-in creates short-lived administrative test sessions in Centre only.
assert.ok(process.argv.includes('--bootstrap-test-sessions'), 'Pass --bootstrap-test-sessions to exercise the deployed Centre database.');
const token = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token, 'CLOUDFLARE_API_TOKEN is required for bounded test-session setup and revocation.');
const config = JSON.parse(await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases.find(value => value.binding === 'DB');
assert.equal(database.database_name, 'centre-production');
assert.equal(database.database_id, '16c45b97-0c59-4293-9c79-e1f1aa0ef081');
const origin = 'https://centre-cloud.etphli.workers.dev';
const report = { origin, checkedAt: new Date().toISOString(), checks: [], liveGoogleLogin: false, liveOrganatoWrites: false, passed: false };
const createdDevices = [];
const hash = value => createHash('sha256').update(value).digest('hex');
async function query(sql, params) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${database.database_id}/query`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, 'Cloudflare D1 administration HTTP status');
  assert.equal(value.success, true, 'Cloudflare D1 administration result');
  return value.result;
}
async function device() {
  const id = randomUUID(), bearer = `ctr_${randomBytes(32).toString('hex')}`, workspace = `cw_${hash(randomUUID())}`;
  createdDevices.push(id);
  await query('INSERT INTO centre_device(id,workspace,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)', [id, workspace, hash(bearer), 'Temporary deployment verification', new Date().toISOString(), new Date(Date.now() + 600000).toISOString()]);
  return { id, bearer, workspace };
}
async function call(path, session, method = 'GET', body) {
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(60000), headers: { ...(session ? { Authorization: `Bearer ${session.bearer}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
}
try {
  assert.equal((await call('/v1/bootstrap')).status, 401);
  const invalid = await call('/v1/auth/google', null, 'POST', { idToken: 'invalid-deployment-verification', deviceName: 'Verification' });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.value.error.code, 'invalid_identity');
  report.checks.push('Unauthenticated access and invalid Google identity denied');
  const a = await device(), b = await device();
  const bootstrap = await call('/v1/bootstrap', a);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.value.workspaceId, a.workspace);
  report.checks.push('Authenticated deployed router and independent D1 binding');
  const now = new Date().toISOString();
  const chat = projectChatForSync(chatSchema.parse({ id: randomUUID(), title: 'Temporary deployment verification', createdAt: now, updatedAt: now, messages: [] }));
  const mutation = { mutationId: randomUUID(), kind: 'chat', id: chat.id, schemaVersion: 1, expectedVersion: 0, deleted: false, data: chat };
  const first = await call('/v1/records', a, 'POST', mutation);
  assert.equal(first.status, 200);
  const saved = cloudRecordSchema.parse(first.value.record);
  assert.equal(saved.version, 1);
  const replay = await call('/v1/records', a, 'POST', mutation);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.value.record, first.value.record);
  assert.equal((await call('/v1/records', a, 'POST', { ...mutation, mutationId: randomUUID() })).status, 409);
  const foreign = await call('/v1/changes?cursor=0&limit=100', b);
  assert.equal(foreign.status, 200);
  assert.equal(cloudChangesSchema.parse(foreign.value).records.length, 0);
  report.checks.push('Durable record write, exact retry, stale CAS rejection and two-workspace isolation');
  const invitation = await call('/v1/pairings', a, 'POST', {});
  assert.equal(invitation.status, 200);
  const paired = await call('/v1/auth/pair', null, 'POST', { code: invitation.value.code, deviceName: 'Temporary paired deployment verification' });
  assert.equal(paired.status, 200);
  const auth = cloudAuthSchema.parse(paired.value);
  createdDevices.push(auth.deviceId);
  const c = { id: auth.deviceId, bearer: auth.token, workspace: auth.workspaceId };
  assert.equal(c.workspace, a.workspace);
  assert.equal((await call('/v1/bootstrap', c)).status, 200);
  assert.equal((await call('/v1/auth/pair', null, 'POST', { code: invitation.value.code, deviceName: 'Repeated invitation' })).status, 401);
  await call('/v1/devices/revoke', a, 'POST', { deviceId: c.id });
  assert.equal((await call('/v1/bootstrap', c)).status, 401);
  report.checks.push('One-time native pairing, rejected replay and device revocation');
  const message = projectMessageForSync(messageSchema.parse({ id: randomUUID(), role: 'user', content: 'Reply with just the word READY.', createdAt: now }), chat.id);
  const write = await call('/v1/records', a, 'POST', { mutationId: randomUUID(), kind: 'message', id: message.id, schemaVersion: 1, expectedVersion: 0, deleted: false, data: message });
  assert.equal(write.status, 200);
  const run = { id: randomUUID(), chatId: chat.id, messageId: message.id };
  const answer = await call('/v1/ai/runs', a, 'POST', run);
  assert.equal(answer.status, 200, 'Live hosted AI must complete successfully');
  assert.equal(answer.value.run.status, 'completed');
  assert.ok(answer.value.run.result?.trim());
  const repeated = await call('/v1/ai/runs', a, 'POST', run);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.value.run.assistantMessageId, answer.value.run.assistantMessageId);
  assert.equal((await call(`/v1/ai/runs/${run.id}`, b)).status, 404);
  report.liveAi = { model: answer.value.run.model, status: answer.value.run.status, responseCharacters: answer.value.run.result.length };
  report.checks.push('REAL Workers AI inference, durable assistant message, replay and foreign-run denial');
  const archive = await call('/v1/records', a, 'POST', { ...mutation, mutationId: randomUUID(), expectedVersion: 1, data: { ...chat, deletedAt: new Date().toISOString() } });
  assert.equal(archive.status, 200);
  assert.equal((await call('/v1/ai/runs', a, 'POST', run)).status, 404);
  report.checks.push('Archived chat blocks later AI result access');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (createdDevices.length) {
    await query(`UPDATE centre_device SET revoked_at=? WHERE id IN(${createdDevices.map(() => '?').join(',')})`, [new Date().toISOString(), ...createdDevices]);
    report.revokedTemporaryDevices = createdDevices.length;
  }
  report.identityProof = 'Short-lived administrative verification sessions, not a live Google login. Dummy records remain only in isolated verification workspaces.';
  await mkdir('.runtime/feature-program/deployment-20261023', { recursive: true });
  await writeFile('.runtime/feature-program/deployment-20261023/live-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
