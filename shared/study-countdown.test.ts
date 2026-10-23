import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyStudyLog, recoverStudySession, studySessionSchema, timerRemainingMs } from './study-log';
import { applyStudyCloudRecord, studyLogToCloudRecords } from './study-log-sync';

const checkpoint = Date.parse('2026-10-23T00:00:00.000Z');
function countdown() {
  const stamp = new Date(checkpoint).toISOString();
  return studySessionSchema.parse({
    schemaVersion: 1, id: randomUUID(), revision: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null,
    source: 'timer', subjectId: null, taskId: null, title: 'Study session', notes: '', timeZone: 'Australia/Sydney',
    targetMinutes: 30, segments: [], state: { kind: 'running', since: stamp, checkpointAt: stamp, lastActivityAt: stamp, confirmedAt: stamp },
  });
}

test('countdown remaining uses active time and remains unchanged during recovery and cloud import', () => {
  const running = countdown();
  assert.equal(timerRemainingMs(running, checkpoint + 1000), 1799000);
  const recovered = recoverStudySession(running, checkpoint + 3600000, true);
  assert.equal(timerRemainingMs(recovered, checkpoint + 7200000), 1800000);
  const imported = applyStudyCloudRecord(emptyStudyLog(), studyLogToCloudRecords({ schemaVersion: 1, sessions: [running], goals: [] })[0], checkpoint + 3600000);
  assert.equal(imported.sessions[0].targetMinutes, 30);
  assert.deepEqual(imported.sessions[0].state, { kind: 'paused', reason: 'recovery' });
  assert.equal(timerRemainingMs(imported.sessions[0], checkpoint + 7200000), 1800000);
});

test('legacy stopwatch records stay valid and manual records reject countdown targets', () => {
  const { targetMinutes: _target, ...legacy } = countdown();
  const parsed = studySessionSchema.parse(legacy);
  assert.equal(timerRemainingMs(parsed, checkpoint + 1000), null);
  const end = new Date(checkpoint + 1000).toISOString();
  assert.equal(studySessionSchema.safeParse({ ...countdown(), source: 'manual', segments: [{ start: legacy.createdAt, end }], state: { kind: 'completed' } }).success, false);
});
