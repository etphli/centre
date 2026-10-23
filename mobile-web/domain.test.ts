import test from 'node:test';
import assert from 'node:assert/strict';
import { manualSession, newTimer, timerChange, pairingCode, records } from './domain';
import { studySessionSchema } from '../shared/study-log';
const now = Date.parse('2026-10-23T02:00:00Z');
test('manual study uses exact local zone and rejects future or invalid durations', () => {
  const entry = manualSession({title:'Physics',date:'2026-10-23',time:'10:00',minutes:60,subjectId:null,timeZone:'Australia/Sydney'},now);
  assert.equal(entry.segments[0].start,'2026-10-22T23:00:00.000Z');
  assert.equal(entry.segments[0].end,'2026-10-23T00:00:00.000Z');
  assert.throws(()=>manualSession({title:'Later',date:'2026-10-24',time:'10:00',minutes:60,subjectId:null,timeZone:'Australia/Sydney'},now));
  assert.throws(()=>manualSession({title:'Invalid',date:'2026-10-23',time:'10:00',minutes:0,subjectId:null,timeZone:'Australia/Sydney'},now));
});
test('timer checkpoints retain measured seconds and lease expiry never credits a closed app', () => {
  const timer = newTimer('Read',null,'UTC',now);
  const checkpoint = timerChange(timer,'heartbeat',now+15_000);
  const recovered = timerChange(checkpoint,'heartbeat',now+90_000);
  assert.equal(recovered.state.kind,'paused');
  assert.deepEqual(recovered.segments,[{start:new Date(now).toISOString(),end:new Date(now+15_000).toISOString()}]);
  const resumed = timerChange(recovered,'resume',now+100_000);
  const paused = timerChange(resumed,'pause',now+105_123);
  assert.equal(paused.segments[1].end,new Date(now+105_123).toISOString());
  assert.equal(studySessionSchema.parse(paused).revision,5);
});
test('pairing accepts only bare code or own-origin private fragment; malformed cloud data stays hidden', () => {
  const code='a'.repeat(64);
  assert.equal(pairingCode(`https://centre.example/pair#code=${code}`,'https://centre.example'),code);
  assert.throws(()=>pairingCode(`https://other.example/pair#code=${code}`,'https://centre.example'));
  assert.throws(()=>pairingCode(`https://centre.example/pair?code=${code}`,'https://centre.example'));
  assert.deepEqual(records([],'studySession',studySessionSchema),[]);
});
