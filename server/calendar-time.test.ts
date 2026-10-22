import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { assignmentSchema, calendarEventSchema, eventSchema, type StudyEvent } from '../shared/schema';
import { aggregateCalendarWeek, calendarStartInstant, calendarTodayKey, calendarWeekDays, calendarWeekStart, eventInterval, projectCalendarEvent, upsertCalendarEventProjection } from '../shared/calendar-time';

const event = (overrides: Partial<StudyEvent> = {}) => eventSchema.parse({
  id: 'session', origin: 'centre', kind: 'session', title: 'Study', date: '2026-10-05', time: '10:00',
  plannedDurationMinutes: 60, timeZone: 'Australia/Sydney', ...overrides,
});
const week = (events: StudyEvent[], weekStart = '2026-10-05', timeZone = 'Australia/Sydney', assignments: ReturnType<typeof assignmentSchema.parse>[] = []) =>
  aggregateCalendarWeek({ weekStart, timeZone, events, assignments });
const day = (days: ReturnType<typeof week>, date: string) => {
  const result = days.find(value => value.date === date);
  assert.ok(result, `Missing day ${date}`);
  return result;
};

test('weeks start Monday across year boundaries and today uses the configured IANA zone', () => {
  assert.equal(calendarWeekStart('2027-01-03'), '2026-12-28');
  assert.equal(calendarWeekStart('2027-01-04'), '2027-01-04');
  assert.deepEqual(calendarWeekDays('2027-01-03'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  const now = Temporal.Instant.from('2026-10-04T14:30:00Z');
  assert.equal(calendarTodayKey('Australia/Sydney', now), '2026-10-05');
  assert.equal(calendarTodayKey('America/Los_Angeles', now), '2026-10-04');
});

test('DST days have 23 or 25 elapsed hours and reject missing or ambiguous wall times', () => {
  assert.equal(day(week([], '2026-09-28'), '2026-10-04').dayLengthMinutes, 1380);
  assert.equal(day(week([], '2026-03-30'), '2026-04-05').dayLengthMinutes, 1500);
  assert.throws(() => calendarStartInstant('2026-10-04', '02:30', 'Australia/Sydney'), RangeError);
  assert.throws(() => calendarStartInstant('2026-04-05', '02:30', 'Australia/Sydney'), RangeError);
});

test('session durations are elapsed minutes across both DST transitions', () => {
  for (const [date, expectedClock] of [['2026-10-04', '04:30'], ['2026-04-05', '02:30']]) {
    const interval = eventInterval(event({ date, time: '01:30', plannedDurationMinutes: 120 }));
    assert.ok(interval);
    assert.equal(interval.start.until(interval.end).total('minutes'), 120);
    assert.equal(interval.end.toZonedDateTimeISO('Australia/Sydney').toPlainTime().toString({ smallestUnit: 'minute' }), expectedClock);
  }
});

test('sessions crossing midnight split into clipped day segments including the previous week', () => {
  const days = week([event({ date: '2026-10-04', time: '23:30', plannedDurationMinutes: 120 })]);
  const segments = day(days, '2026-10-05').sessions;
  assert.equal(segments.length, 1);
  const [segment] = segments;
  assert.ok(segment);
  assert.equal(segment.plannedDurationMinutes, 120);
  assert.equal(segment.durationMinutes, 90);
  assert.equal(segment.startMinute, 0);
  assert.equal(segment.endMinute, 90);
  assert.equal(segment.continuesFromPreviousDay, true);
  assert.equal(segment.continuesIntoNextDay, false);
  assert.equal(segment.start.until(segment.end).total('minutes'), 120);
  assert.equal(segment.displayStart.until(segment.displayEnd).total('minutes'), 90);
});

test('viewer timezone selects session dates while legacy starts retain their event timezone', () => {
  const days = week([event({ date: '2026-10-05', time: '00:30' })], '2026-09-28', 'America/Los_Angeles');
  assert.equal(day(days, '2026-10-04').sessions[0]?.startMinute, 390);
  const absolute = week([event({ date: '2026-10-04', time: null, startAt: '2026-10-04T14:30:00Z' })]);
  assert.equal(day(absolute, '2026-10-05').sessions[0]?.startMinute, 90);
});

test('DST layout exposes elapsed offsets alongside wall clock minutes', () => {
  const spring = day(week([event({ date: '2026-10-04', time: '01:30', plannedDurationMinutes: 120 })], '2026-09-28'), '2026-10-04').sessions[0];
  assert.ok(spring);
  assert.equal(spring.startMinute, 90);
  assert.equal(spring.endMinute, 270);
  assert.equal(spring.elapsedStartMinute, 90);
  assert.equal(spring.elapsedEndMinute, 210);
  const fall = day(week([event({ date: '2026-04-05', time: '01:30', plannedDurationMinutes: 120 })], '2026-03-30'), '2026-04-05').sessions[0];
  assert.ok(fall);
  assert.equal(fall.elapsedEndMinute, 210);
  assert.equal(fall.endMinute, 150);
});

test('overlap lanes reuse space and treat touching boundaries as non-overlapping', () => {
  const sessions = day(week([
    event({ id: 'a', time: '09:00', plannedDurationMinutes: 120 }),
    event({ id: 'b', time: '09:30', plannedDurationMinutes: 30 }),
    event({ id: 'c', time: '10:00', plannedDurationMinutes: 90 }),
    event({ id: 'd', time: '11:30', plannedDurationMinutes: 30 }),
  ]), '2026-10-05').sessions;
  assert.deepEqual(sessions.map(value => [value.event.id, value.lane, value.laneCount, value.overlapIds]), [
    ['a', 0, 2, ['b', 'c']], ['b', 1, 2, ['a']], ['c', 1, 2, ['a']], ['d', 0, 1, []],
  ]);
});

test('latest revisions win, tombstones hide stale copies, and imported sessions remain deadlines', () => {
  const days = week([
    event({ id: 'removed', revision: 3, deletedAt: '2026-10-01T00:00:00Z' }),
    event({ id: 'removed', revision: 2 }),
    event({ id: 'changed', revision: 1, time: '10:00' }),
    event({ id: 'changed', revision: 2, time: '12:00' }),
    event({ id: 'imported', origin: 'organato' }),
  ]);
  assert.deepEqual(day(days, '2026-10-05').sessions.map(value => [value.event.id, value.startMinute]), [['changed', 720]]);
  assert.deepEqual(day(days, '2026-10-05').deadlines.map(value => value.id), ['imported']);
});

test('Organato projections dedupe each other and their assignment fallback', () => {
  const assignment = assignmentSchema.parse({ id: 'task', title: 'Essay', kind: 'work', subjectId: null, dueDate: '2026-10-05', status: 'incomplete', version: 1 });
  const days = week([
    event({ id: 'old', origin: 'organato', kind: 'deadline', organatoId: 'task', revision: 1 }),
    event({ id: 'new', origin: 'organato', kind: 'deadline', organatoId: 'task', revision: 2 }),
  ], '2026-10-05', 'Australia/Sydney', [assignment, assignment]);
  assert.deepEqual(day(days, '2026-10-05').deadlines.map(value => value.id), ['new']);
  assert.equal(day(week([], '2026-10-05', 'Australia/Sydney', [assignment, assignment]), '2026-10-05').deadlines.length, 1);
  assert.equal(day(week([], '2026-10-05', 'Australia/Sydney', [assignment]), '2026-10-05').deadlines[0]?.done, false);
});

test('timed deadlines and assignment instants use viewer timezone, date-only deadlines stay on their date', () => {
  const assignment = assignmentSchema.parse({ id: 'task', title: 'Essay', kind: 'work', subjectId: null, dueDate: '2026-10-04T14:30:00Z', status: 'submitted', version: 1 });
  const deadlines = day(week([
    event({ id: 'timed', kind: 'deadline', date: '2026-10-04', startAt: '2026-10-04T14:30:00Z' }),
    event({ id: 'all-day', kind: 'deadline', time: null }),
  ], '2026-10-05', 'Australia/Sydney', [assignment]), '2026-10-05').deadlines;
  assert.deepEqual(new Set(deadlines.map(value => value.id)), new Set(['timed', 'all-day', 'task']));
  assert.equal(deadlines.find(value => value.id === 'timed')?.time, '01:30');
});

test('projection hooks preserve imported records and planned sessions expose no actual Log minutes', () => {
  const canonical = calendarEventSchema.parse(event({id:'d08320ec-19d8-4c2e-a131-10a4a58cb29e',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-05T01:00:00Z',startAt:'2026-10-04T23:00:00Z',completedAt:'2026-10-05T01:00:00Z'}));
  const imported = event({ origin: 'organato' });
  assert.deepEqual(projectCalendarEvent(canonical), canonical);
  const projections = upsertCalendarEventProjection([imported, {...canonical,revision:1}], { ...canonical, revision: 2 });
  assert.equal(projections.length, 2);
  assert.equal(projections[0], imported);
  assert.equal(projections[1]?.revision, 2);
  const result = week([canonical]);
  assert.equal(day(result, '2026-10-05').sessions[0]?.plannedDurationMinutes, 60);
  assert.equal('actualMinutes' in day(result, '2026-10-05'), false);
  assert.equal('actualMinutes' in (day(result, '2026-10-05').sessions[0] ?? {}), false);
});

test('canonical calendar records reject imported projections and inconsistent local starts', () => {
  const canonical = { ...event({id:'d08320ec-19d8-4c2e-a131-10a4a58cb29e',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-05T01:00:00Z',startAt:'2026-10-04T23:00:00Z'}) };
  assert.equal(calendarEventSchema.safeParse(canonical).success,true);
  assert.equal(calendarEventSchema.safeParse({...canonical,origin:'organato'}).success,false);
  assert.equal(calendarEventSchema.safeParse({...canonical,startAt:'2026-10-05T00:00:00Z'}).success,false);
  assert.equal(calendarEventSchema.safeParse({...canonical,date:'2026-10-04',time:'02:30',startAt:'2026-10-03T16:30:00Z'}).success,false);
  assert.equal(calendarEventSchema.safeParse({...canonical,kind:'deadline'}).success,false);
});

test('midnight segments preserve total planned minutes without adding a zero-length next day', () => {
  const days = week([
    event({ id: 'cross', time: '23:30', plannedDurationMinutes: 120 }),
    event({ id: 'ends-midnight', date: '2026-10-06', time: '23:00', plannedDurationMinutes: 60 }),
    event({ id: 'next-week', date: '2026-10-12', time: '00:00' }),
  ]);
  const segments = days.flatMap(value => value.sessions).filter(value => value.event.id === 'cross');
  assert.equal(segments.reduce((sum, value) => sum + value.durationMinutes, 0), 120);
  assert.equal(segments[0]?.endMinute, 1440);
  assert.equal(segments[0]?.continuesIntoNextDay, true);
  assert.equal(segments[1]?.continuesFromPreviousDay, true);
  assert.equal(day(days, '2026-10-07').sessions.length, 0);
  assert.equal(days.flatMap(value => value.sessions).some(value => value.event.id === 'next-week'), false);
});

test('repeated DST clock times use distinct instants when assigning overlap lanes', () => {
  const sessions = day(week([
    event({ id: 'early', date: '2026-04-05', time: '02:15', startAt: '2026-04-04T15:15:00Z', plannedDurationMinutes: 30 }),
    event({ id: 'late', date: '2026-04-05', time: '02:15', startAt: '2026-04-04T16:15:00Z', plannedDurationMinutes: 30 }),
  ], '2026-03-30'), '2026-04-05').sessions;
  assert.deepEqual(sessions.map(value => [value.startMinute, value.elapsedStartMinute, value.laneCount, value.overlapIds]), [
    [135, 135, 1, []], [135, 195, 1, []],
  ]);
});

test('import tombstones suppress assignment resurrection and invalid sessions are omitted', () => {
  const assignment = assignmentSchema.parse({ id: 'task', title: 'Essay', kind: 'work', subjectId: null, dueDate: '2026-10-05', status: 'done', version: 1 });
  const days = week([
    event({ id: 'old', origin: 'organato', organatoId: 'task' }),
    event({ id: 'new', origin: 'organato', organatoId: 'task', revision: 2, deletedAt: '2026-10-01T00:00:00Z' }),
    event({ id: 'invalid', time: 'invalid' }),
    event({ id: 'no-time', time: null }),
  ], '2026-10-05', 'Australia/Sydney', [assignment]);
  assert.equal(days.flatMap(value => value.sessions).length, 0);
  assert.equal(days.flatMap(value => value.deadlines).length, 0);
  assert.equal(eventInterval(event({ deletedAt: '2026-10-01T00:00:00Z' })), null);
});
