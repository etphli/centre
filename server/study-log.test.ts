import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyLogService } from './study-log';
import { Store } from './store';
import { createService } from './index';
import { validateRequest } from '../electron/security';
import { CHECK_IN_MS, IDLE_MS, durationMs, emptyStudyLog, localStudyInstant, recoverStudySession, sessionSegments, shiftStudyDate, studyDayBounds, studyLogSchema, studySessionSchema, weekStartAt, weeklyStudy, type StudySession } from '../shared/study-log';

const tags = { subjectId: null, taskId: null, title: 'Algebra', notes: '', timeZone: 'Australia/Sydney' };
const at = (value: string) => Date.parse(value);
function completed(start: string, end: string, extra: Partial<StudySession> = {}): StudySession {
  return studySessionSchema.parse({ ...tags, schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: start, updatedAt: end, deletedAt: null, source: 'manual', segments: [{ start, end }], state: { kind: 'completed' }, ...extra });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'centre-study-'));
  const store = await Store.open(directory);
  let now = at('2026-10-22T00:00:00.000Z');
  const service = new StudyLogService(store, () => now);
  const call = (path: string, value?: unknown, method = 'POST') => service.route(method, `/api/study-log${path}`, value);
  return { directory, store, service, call, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; }, now: () => now, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('countdown completes at the chosen duration, excluding pauses, and persists its target', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    let log = await f.call('/timer/start', { id, ...tags, targetMinutes: 5 });
    const command = async (action: string) => { log = await f.call(`/timer/${id}/${action}`, { expectedRevision: log.sessions[0].revision, activity: true }); };
    for (let i = 0; i < 10; i++) { f.advance(15000); await command('heartbeat'); }
    await command('pause');
    f.advance(3600000); await command('resume');
    for (let i = 0; i < 9; i++) { f.advance(15000); await command('heartbeat'); }
    f.advance(20000); await command('heartbeat');
    assert.equal(log.sessions[0].state.kind, 'completed');
    assert.equal(durationMs(log.sessions[0].segments), 300000);
    const saved = (await Store.open(f.directory)).state.studyLog.sessions[0];
    assert.equal(Reflect.get(saved, 'targetMinutes'), 5);
    assert.equal(saved.state.kind, 'completed');
    await assert.rejects(f.call('/timer/start', { id, ...tags, targetMinutes: 10 }), /already in use/);
  } finally { await f.cleanup(); }
});

test('countdown rejects invalid increments and recovery excludes unattended time', async () => {
  const f = await fixture();
  try {
    for (const targetMinutes of [0, 1, 7, 30.5, 1445]) {
      await assert.rejects(f.call('/timer/start', { id: randomUUID(), ...tags, targetMinutes }));
    }
    const id = randomUUID();
    let log = await f.call('/timer/start', { id, ...tags, targetMinutes: 30 });
    f.advance(15000);
    log = await f.call(`/timer/${id}/heartbeat`, { expectedRevision: log.sessions[0].revision, activity: true });
    f.advance(3600000);
    log = await f.service.recover(true);
    assert.deepEqual(log.sessions[0].state, { kind: 'paused', reason: 'recovery' });
    assert.equal(durationMs(log.sessions[0].segments), 15000);
    assert.equal(Reflect.get(log.sessions[0], 'targetMinutes'), 30);
  } finally { await f.cleanup(); }
});

test('timer persists pause/resume intervals, excludes paused and restart time, and stops once', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    let log = await f.call('/timer/start', { id, ...tags });
    const command = async (action: string, activity = false) => { log = await f.call(`/timer/${id}/${action}`, { expectedRevision: log.sessions[0].revision, activity }); };
    f.advance(30000); await command('heartbeat', true);
    f.advance(10000); await command('pause');
    assert.equal(durationMs(log.sessions[0].segments), 40000);
    f.advance(2 * 3600000); await command('resume');
    f.advance(30000); await command('heartbeat', true);
    const saved = await Store.open(f.directory);
    f.advance(8 * 3600000);
    const restarted = new StudyLogService(saved, f.now);
    log = await restarted.recover(true);
    assert.deepEqual(log.sessions[0].state, { kind: 'paused', reason: 'recovery' });
    assert.equal(durationMs(log.sessions[0].segments), 70000);
    log = await restarted.route('POST', `/api/study-log/timer/${id}/resume`, { expectedRevision: log.sessions[0].revision });
    f.advance(15000);
    log = await restarted.route('POST', `/api/study-log/timer/${id}/stop`, { expectedRevision: log.sessions[0].revision });
    assert.equal(durationMs(log.sessions[0].segments), 85000);
    assert.equal(log.sessions[0].state.kind, 'completed');
    await assert.rejects(restarted.route('POST', `/api/study-log/timer/${id}/resume`, { expectedRevision: log.sessions[0].revision }), /already stopped/);
    assert.equal((await Store.open(f.directory)).state.studyLog.sessions[0].state.kind, 'completed');
  } finally { await f.cleanup(); }
});

test('lease loss, idle, check-in, and backwards clock recover without silently resuming', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); let log = await f.call('/timer/start', { id, ...tags });
    for (let index = 0; index < IDLE_MS / 15000; index++) {
      f.advance(15000); log = await f.call(`/timer/${id}/heartbeat`, { expectedRevision: log.sessions[0].revision, activity: false });
    }
    assert.deepEqual(log.sessions[0].state, { kind: 'paused', reason: 'idle' });
    assert.equal(durationMs(log.sessions[0].segments), IDLE_MS);
    f.advance(100000); log = await f.call(`/timer/${id}/resume`, { expectedRevision: log.sessions[0].revision });
    for (let index = 0; index < CHECK_IN_MS / 15000; index++) {
      f.advance(15000); log = await f.call(`/timer/${id}/heartbeat`, { expectedRevision: log.sessions[0].revision, activity: true });
    }
    assert.deepEqual(log.sessions[0].state, { kind: 'paused', reason: 'check-in' });
    assert.equal(durationMs(log.sessions[0].segments), IDLE_MS + CHECK_IN_MS);
    log = await f.call(`/timer/${id}/resume`, { expectedRevision: log.sessions[0].revision });
    f.advance(15000); log = await f.call(`/timer/${id}/heartbeat`, { expectedRevision: log.sessions[0].revision, activity: true });
    const checkpoint = log.sessions[0];
    f.advance(12 * 3600000); log = await f.service.recover();
    assert.deepEqual(log.sessions[0].state, { kind: 'paused', reason: 'recovery' });
    assert.equal(durationMs(log.sessions[0].segments), IDLE_MS + CHECK_IN_MS + 15000);
    assert.deepEqual(recoverStudySession(checkpoint, at(checkpoint.updatedAt) - 1000).state, { kind: 'paused', reason: 'clock' });
  } finally { await f.cleanup(); }
});

test('manual edit/delete, idempotent create, optimistic conflicts and concurrent writes survive disk reopen', async () => {
  const f = await fixture();
  try {
    const input = { ...tags, id: randomUUID(), segments: [{ start: '2026-10-21T02:00:00.000Z', end: '2026-10-21T03:00:00.000Z' }] };
    let log = await f.call('/sessions', input);
    await f.call('/sessions', input); assert.equal(f.store.state.studyLog.sessions.length, 1);
    await assert.rejects(f.call('/sessions', { ...input, id: randomUUID() }), /overlaps/);
    const edit = { ...tags, title: 'Edited', expectedRevision: 1, segments: [{ start: '2026-10-21T02:00:00.000Z', end: '2026-10-21T04:00:00.000Z' }] };
    const results = await Promise.allSettled([f.call(`/sessions/${input.id}`, edit, 'PATCH'), f.call(`/sessions/${input.id}`, edit, 'PATCH')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    log = f.store.state.studyLog;
    assert.equal(weeklyStudy(log.sessions, '2026-10-19', tags.timeZone, f.now()).durationMs, 7200000);
    assert.equal((await Store.open(f.directory)).state.studyLog.sessions[0].title, 'Edited');
    log = await f.call(`/sessions/${input.id}/delete`, { expectedRevision: 2 });
    assert.equal(weeklyStudy(log.sessions, '2026-10-19', tags.timeZone, f.now()).durationMs, 0);
    assert.ok((await Store.open(f.directory)).state.studyLog.sessions[0].deletedAt);
    const timer = randomUUID(); await f.call('/timer/start', { id: timer, ...tags });
    await assert.rejects(f.call('/timer/start', { id: randomUUID(), ...tags }), /Stop the current timer/);
    f.advance(30000);
    await assert.rejects(f.call('/sessions', { ...input, id: randomUUID(), segments: [{ start: new Date(f.now() - 10000).toISOString(), end: new Date(f.now()).toISOString() }] }), /overlaps/);
  } finally { await f.cleanup(); }
});

test('boundary rules reject future time, malformed intervals, unknown tags, invalid zones and immutable active records', async () => {
  const f = await fixture();
  try {
    const input = { ...tags, id: randomUUID(), segments: [{ start: '2026-10-21T00:00:00.000Z', end: '2026-10-21T01:00:00.000Z' }] };
    for (const patch of [{ subjectId: 'unknown' }, { taskId: 'unknown' }, { timeZone: 'Mars/Base' }, { segments: [{ start: '2026-10-23T00:00:00.000Z', end: '2026-10-23T01:00:00.000Z' }] }, { segments: [{ start: input.segments[0].end, end: input.segments[0].start }] }, { segments: [] }, { extra: true }]) await assert.rejects(f.call('/sessions', { ...input, ...patch }));
    const id = randomUUID(); await f.call('/timer/start', { id, ...tags });
    await assert.rejects(f.call(`/sessions/${id}/delete`, { expectedRevision: 1 }), /Stop this timer/);
    assert.equal(f.store.state.studyLog.sessions.length, 1);
    await assert.rejects(f.call('/goals', { id: randomUUID(), weekStart: '2026-10-20', timeZone: tags.timeZone, targetMinutes: 600 }));
    await assert.rejects(f.call('/goals', { id: randomUUID(), weekStart: '2026-10-19', timeZone: tags.timeZone, targetMinutes: 10081 }));
  } finally { await f.cleanup(); }
});

test('weekly aims persist independently by week and zone and reject stale updates', async () => {
  const f = await fixture();
  try {
    const goal = { id: randomUUID(), weekStart: '2026-10-19', timeZone: tags.timeZone, targetMinutes: 600 };
    await f.call('/goals', goal); await f.call('/goals', goal);
    await f.call('/goals', { ...goal, expectedRevision: 1, targetMinutes: 720 });
    await assert.rejects(f.call('/goals', { ...goal, expectedRevision: 1, targetMinutes: 900 }), /changed/);
    await assert.rejects(f.call('/goals', { ...goal, id: randomUUID() }), /already has an aim/);
    await f.call('/goals', { ...goal, id: randomUUID(), weekStart: '2026-10-26' });
    const saved = await Store.open(f.directory);
    assert.equal(saved.state.studyLog.goals.length, 2); assert.equal(saved.state.studyLog.goals[0].targetMinutes, 720);
  } finally { await f.cleanup(); }
});

test('DST days, overnight sessions, Monday boundaries and defensive overlap totals use elapsed UTC time', () => {
  assert.equal(studyDayBounds('2026-10-04', tags.timeZone).end - studyDayBounds('2026-10-04', tags.timeZone).start, 23 * 3600000);
  assert.equal(studyDayBounds('2026-04-05', tags.timeZone).end - studyDayBounds('2026-04-05', tags.timeZone).start, 25 * 3600000);
  assert.throws(() => localStudyInstant('2026-10-04', '02:30', tags.timeZone));
  assert.throws(() => localStudyInstant('2026-04-05', '02:30', tags.timeZone));
  const overnight = completed(localStudyInstant('2026-10-18', '23:00', tags.timeZone), localStudyInstant('2026-10-19', '01:00', tags.timeZone));
  const previous = weeklyStudy([overnight], '2026-10-12', tags.timeZone, Date.now());
  const next = weeklyStudy([overnight], '2026-10-19', tags.timeZone, Date.now());
  assert.equal(previous.durationMs, 3600000); assert.equal(previous.days[6].durationMs, 3600000); assert.equal(next.days[0].durationMs, 3600000);
  assert.equal(weekStartAt(at(localStudyInstant('2026-10-19', '00:00', tags.timeZone)), tags.timeZone), '2026-10-19');
  assert.equal(weekStartAt(at('2026-10-18T12:59:59.999Z'), tags.timeZone), '2026-10-12');
  assert.equal(shiftStudyDate('2026-12-28', 7), '2027-01-04');
  const a = completed('2026-10-20T00:00:00.000Z', '2026-10-20T02:00:00.000Z', { subjectId: 'math' });
  const b = completed('2026-10-20T01:00:00.000Z', '2026-10-20T03:00:00.000Z', { subjectId: 'english' });
  const total = weeklyStudy([b, a], '2026-10-19', tags.timeZone, Date.now());
  assert.equal(total.durationMs, 3 * 3600000); assert.equal(total.subjects.reduce((sum, subject) => sum + subject.durationMs, 0), total.durationMs);
  assert.equal(weeklyStudy([a], '2026-10-19', 'America/Los_Angeles', Date.now()).durationMs, 7200000);
  const dst = completed(localStudyInstant('2026-10-04', '01:30', tags.timeZone), localStudyInstant('2026-10-04', '03:30', tags.timeZone));
  assert.equal(durationMs(dst.segments), 3600000);
});

test('failed atomic save preserves confirmed in-memory and on-disk state; legacy snapshots default empty', async () => {
  const f = await fixture();
  try {
    await f.store.save();
    const original = await readFile(join(f.directory, 'state.json'), 'utf8');
    await mkdir(join(f.directory, 'state.json.tmp'));
    await assert.rejects(f.call('/timer/start', { id: randomUUID(), ...tags }));
    assert.deepEqual(f.store.state.studyLog, emptyStudyLog());
    assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), original);
    await rm(join(f.directory, 'state.json.tmp'), { recursive: true });
    const legacy = JSON.parse(original); delete legacy.studyLog;
    await writeFile(join(f.directory, 'state.json'), JSON.stringify(legacy));
    assert.deepEqual((await Store.open(f.directory)).state.studyLog, emptyStudyLog());
  } finally { await f.cleanup(); }
});

test('authenticated local API and desktop allowlist expose only supported study routes', async () => {
  const f = await fixture(); const original = process.env.CENTRE_CODEX_BIN; process.env.CENTRE_CODEX_BIN = '/centre-test/no-codex';
  const service = await createService({ dataDir: f.directory });
  try {
    const root = `http://127.0.0.1:${service.port}/api/study-log`;
    assert.equal((await fetch(root)).status, 401);
    const response = await fetch(`${root}/timer/start`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), ...tags }) });
    assert.equal(response.status, 200); assert.equal(studyLogSchema.parse(await response.json()).sessions.length, 1);
    for (const [method, path] of [['GET', ''], ['POST', '/sessions'], ['POST', '/goals'], ['POST', '/timer/start'], ['PATCH', `/sessions/${randomUUID()}`], ...['heartbeat', 'pause', 'resume', 'stop', 'confirm'].map(action => ['POST', `/timer/${randomUUID()}/${action}`])]) assert.doesNotThrow(() => validateRequest(method, `/api/study-log${path}`, method === 'GET' ? undefined : {}));
    for (const path of ['/timer/start/stop', '/timer/arbitrary/resume', '/sessions/../delete', '/goals/delete', '/secrets', '/timer/00000000-0000-4000-8000-000000000000/invalid']) assert.throws(() => validateRequest('POST', `/api/study-log${path}`, {}));
  } finally { await service.close(); process.env.CENTRE_CODEX_BIN = original; await f.cleanup(); }
});

test('portable v1 fixtures and cloud projection preserve one model and never import a running lease', async () => {
  const { applyStudyCloudRecord, studyLogToCloudRecords } = await import('../shared/study-log-sync');
  const fixture = JSON.parse(await readFile(new URL('../shared/fixtures/study-log-v1.json', import.meta.url), 'utf8'));
  const log = studyLogSchema.parse(fixture.log);
  const now = Date.parse(fixture.now);
  assert.equal(weeklyStudy(log.sessions, '2026-10-12', 'Australia/Sydney', now).durationMs, fixture.expected.previousWeekDurationMs);
  assert.equal(weeklyStudy(log.sessions, '2026-10-19', 'Australia/Sydney', now).durationMs, fixture.expected.currentWeekDurationMs);
  let imported = emptyStudyLog();
  for (const record of studyLogToCloudRecords(log)) imported = applyStudyCloudRecord(imported, { ...record, version: 99, cursor: '123' }, now);
  const recovered = imported.sessions.find(session => session.id === log.sessions[1].id);
  assert.ok(recovered); assert.deepEqual(recovered.state, { kind: 'paused', reason: 'recovery' });
  assert.equal(durationMs(recovered.segments), fixture.expected.recoveredTimerDurationMs);
  assert.equal(recovered.revision, fixture.expected.recoveredTimerRevision);
  assert.equal(imported.goals[0].revision, 1);
  const deleted = applyStudyCloudRecord(imported, { kind: 'studySession', id: recovered.id, deleted: true, data: null }, now);
  assert.ok(deleted.sessions.find(session => session.id === recovered.id)?.deletedAt);
  assert.equal(deleted.sessions.find(session => session.id === recovered.id)?.state.kind, 'completed');
  assert.equal(studyLogToCloudRecords(deleted).find(record => record.id === recovered.id)?.deleted, true);
  assert.throws(() => applyStudyCloudRecord(imported, { kind: 'studySession', id: randomUUID(), deleted: false, data: recovered }, now), /ID/);
  assert.throws(() => applyStudyCloudRecord(imported, { kind: 'studySession', id: recovered.id, deleted: false, data: null }, now), /needs live data/);
  assert.throws(() => applyStudyCloudRecord(imported, { kind: 'studySession', id: recovered.id, deleted: false, data: { ...recovered, schemaVersion: 2 } }, now));
});

test('imported paused timers cannot create a second running timer and overlapping history can always stop', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    let log = await f.call('/timer/start', { id, ...tags });
    const imported = studySessionSchema.parse({ ...log.sessions[0], id: randomUUID(), state: { kind: 'paused', reason: 'recovery' } });
    f.store.state.studyLog.sessions.push(imported); await f.store.save();
    await assert.rejects(f.call(`/timer/${imported.id}/resume`, { expectedRevision: imported.revision }), /other running timer/);
    assert.equal(f.store.state.studyLog.sessions.filter(session => session.state.kind === 'running').length, 1);
    f.advance(15000); log = await f.call(`/timer/${id}/stop`, { expectedRevision: log.sessions[0].revision });
    const overlapping = studySessionSchema.parse({ ...imported, segments: log.sessions[0].segments });
    f.store.state.studyLog.sessions = f.store.state.studyLog.sessions.map(session => session.id === imported.id ? overlapping : session);
    log = await f.call(`/timer/${imported.id}/stop`, { expectedRevision: overlapping.revision });
    assert.equal(log.sessions.find(session => session.id === imported.id)?.state.kind, 'completed');
    const total = weeklyStudy(log.sessions, '2026-10-19', tags.timeZone, f.now()).durationMs;
    assert.equal(total, 15000);
    await f.call(`/sessions/${imported.id}/delete`, { expectedRevision: overlapping.revision + 1 });
    assert.equal(weeklyStudy(f.store.state.studyLog.sessions, '2026-10-19', tags.timeZone, f.now()).durationMs, total);
  } finally { await f.cleanup(); }
});

test('a rejected study commit cannot leak into a concurrent unrelated save, and successful commits stay saved', async () => {
  const {writeStateFile} = await import('./store');
  const directory = await mkdtemp(join(tmpdir(),'centre-study-writer-'));
  let fail = false;
  const store = await Store.open(directory,async (directory,content)=>{
    if (fail) { fail=false; throw new Error('rejected study write'); }
    await writeStateFile(directory,content);
  });
  const service = new StudyLogService(store);
  try {
    await store.save();
    fail=true;
    const rejected=service.route('POST','/api/study-log/timer/start',{id:randomUUID(),...tags});
    const concurrent=store.save();
    await assert.rejects(rejected,/rejected study write/); await concurrent;
    assert.equal(store.state.studyLog.sessions.length,0);
    assert.equal((await Store.open(directory)).state.studyLog.sessions.length,0);
    const committed=service.route('POST','/api/study-log/timer/start',{id:randomUUID(),...tags});
    const saved=store.save(); await committed; await saved;
    assert.equal(store.state.studyLog.sessions.length,1);
    assert.equal((await Store.open(directory)).state.studyLog.sessions.length,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
