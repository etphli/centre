import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const HEARTBEAT_MS = 15_000;
export const LEASE_MS = 45_000;
export const IDLE_MS = 10 * 60_000;
export const CHECK_IN_MS = 60 * 60_000;
export const DEFAULT_TIMER_MINUTES = 30;
export const TIMER_STEP_MINUTES = 5;
export const MAX_TIMER_MINUTES = 1440;
export const timerMinutesSchema = z.number().int().min(TIMER_STEP_MINUTES).max(MAX_TIMER_MINUTES).multipleOf(TIMER_STEP_MINUTES);
const instant = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)), 'Use a valid UTC instant.');
export const studyTimeZoneSchema = z.string().max(100).refine(value => {
  try { Temporal.Now.zonedDateTimeISO(value); return true; } catch { return false; }
}, 'Choose a valid IANA time zone.');
export const studySegmentSchema = z.object({ start: instant, end: instant }).strict().refine(value => Date.parse(value.end) > Date.parse(value.start), 'End must be after start.');
export type StudySegment = z.infer<typeof studySegmentSchema>;
export const studySegmentsSchema = z.array(studySegmentSchema).max(5000).refine(values => values.every((value, index) => index === 0 || Date.parse(value.start) >= Date.parse(values[index - 1].end)), 'Study intervals must be chronological and cannot overlap.');
export const studyTagsSchema = z.object({ subjectId: z.string().min(1).max(200).nullable(), taskId: z.string().min(1).max(200).nullable(), title: z.string().trim().min(1).max(200), notes: z.string().max(10000), timeZone: studyTimeZoneSchema }).strict();
const recordShape = { schemaVersion: z.literal(1), id: z.uuid(), revision: z.number().int().positive(), createdAt: instant, updatedAt: instant, deletedAt: instant.nullable() };
export const studySessionSchema = studyTagsSchema.extend({
  ...recordShape, source: z.enum(['timer', 'manual']), segments: studySegmentsSchema,
  targetMinutes: timerMinutesSchema.optional(),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('running'), since: instant, checkpointAt: instant, lastActivityAt: instant, confirmedAt: instant }).strict(),
    z.object({ kind: z.literal('paused'), reason: z.enum(['user', 'idle', 'recovery', 'check-in', 'clock']) }).strict(),
    z.object({ kind: z.literal('completed') }).strict(),
  ]),
}).strict().superRefine((session, ctx) => {
  const state = session.state;
  if (session.source !== 'timer' && session.targetMinutes !== undefined) ctx.addIssue({ code: 'custom', message: 'Only timers have a countdown duration.' });
  if (session.source === 'manual' && (state.kind !== 'completed' || session.segments.length === 0)) ctx.addIssue({ code: 'custom', message: 'Manual study needs completed intervals.' });
  if (session.deletedAt && state.kind !== 'completed') ctx.addIssue({ code: 'custom', message: 'Finish a timer before deleting it.' });
  if (state.kind === 'running') {
    const since = Date.parse(state.since), checkpoint = Date.parse(state.checkpointAt);
    if (checkpoint < since || Date.parse(state.lastActivityAt) < since || Date.parse(state.lastActivityAt) > checkpoint || Date.parse(state.confirmedAt) < since || Date.parse(state.confirmedAt) > checkpoint || (session.segments.at(-1) && Date.parse(session.segments.at(-1)!.end) > since)) ctx.addIssue({ code: 'custom', message: 'Invalid running timer checkpoint.' });
  }
});
export type StudySession = z.infer<typeof studySessionSchema>;
export type StudyTags = z.infer<typeof studyTagsSchema>;
const mondaySchema = z.iso.date().refine(value => { try { return Temporal.PlainDate.from(value).dayOfWeek === 1; } catch { return false; } }, 'Week must start on Monday.');
export const weeklyStudyGoalSchema = z.object({ ...recordShape, weekStart: mondaySchema, timeZone: studyTimeZoneSchema, targetMinutes: z.number().int().min(1).max(10080) }).strict();
export type WeeklyStudyGoal = z.infer<typeof weeklyStudyGoalSchema>;
export const studyLogSchema = z.object({ schemaVersion: z.literal(1), sessions: z.array(studySessionSchema), goals: z.array(weeklyStudyGoalSchema) }).strict();
export type StudyLog = z.infer<typeof studyLogSchema>;
export const emptyStudyLog = (): StudyLog => ({ schemaVersion: 1, sessions: [], goals: [] });
export const studyCreateSchema = studyTagsSchema.extend({ id: z.uuid(), segments: studySegmentsSchema.nonempty() }).strict();
export const studyEditSchema = studyCreateSchema.omit({ id: true }).extend({ expectedRevision: z.number().int().positive() }).strict();
export const timerStartSchema = studyTagsSchema.extend({ id: z.uuid(), targetMinutes: timerMinutesSchema.optional() }).strict();
export const studyRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const timerCommandSchema = studyRevisionSchema.extend({ activity: z.boolean().optional() }).strict();
export const studyGoalInputSchema = weeklyStudyGoalSchema.pick({ id: true, weekStart: true, timeZone: true, targetMinutes: true }).extend({ expectedRevision: z.number().int().positive().optional() }).strict();
export type TimerAction = 'heartbeat' | 'pause' | 'resume' | 'stop' | 'confirm';
export const timerActionSchema = z.enum(['heartbeat', 'pause', 'resume', 'stop', 'confirm']);
const iso = (ms: number) => new Date(ms).toISOString();

export function runningLimit(session: StudySession, now: number): { end: number; reason: 'idle' | 'check-in' | 'recovery' | 'clock' | 'finished' | null } {
  const state = session.state;
  if (state.kind !== 'running') return { end: now, reason: null };
  const checkpoint = Date.parse(state.checkpointAt);
  if (now < checkpoint) return { end: checkpoint, reason: 'clock' };
  const idle = Date.parse(state.lastActivityAt) + IDLE_MS;
  const checkIn = Date.parse(state.confirmedAt) + CHECK_IN_MS;
  const lease = now - checkpoint > LEASE_MS;
  const deadline = session.targetMinutes === undefined ? Infinity : Date.parse(state.since) + Math.max(0, session.targetMinutes * 60000 - durationMs(session.segments));
  const end = Math.min(now, idle, checkIn, lease ? checkpoint : now, deadline);
  return { end, reason: lease && end === checkpoint ? 'recovery' : end === deadline ? 'finished' : end === idle ? 'idle' : end === checkIn ? 'check-in' : null };
}
export function closeRunning(session: StudySession, end: number, state: StudySession['state']): StudySession {
  if (session.state.kind !== 'running') return { ...session, state };
  const start = Date.parse(session.state.since);
  return { ...session, segments: end > start ? [...session.segments, { start: session.state.since, end: iso(end) }] : session.segments, state };
}
export function recoverStudySession(session: StudySession, now: number, restart = false): StudySession {
  if (session.state.kind !== 'running') return session;
  const limit = restart ? { end: Date.parse(session.state.checkpointAt), reason: 'recovery' as const } : runningLimit(session, now);
  if (!limit.reason) return session;
  return { ...closeRunning(session, limit.end, limit.reason === 'finished' ? { kind: 'completed' } : { kind: 'paused', reason: limit.reason }), revision: session.revision + 1, updatedAt: iso(now) };
}
export function timerRemainingMs(session: StudySession, now: number): number | null {
  return session.targetMinutes === undefined ? null : Math.max(0, session.targetMinutes * 60000 - durationMs(sessionSegments(session, now)));
}
export function sessionSegments(session: StudySession, now: number): StudySegment[] {
  if (session.deletedAt) return [];
  if (session.state.kind !== 'running') return session.segments;
  const end = runningLimit(session, now).end;
  return end > Date.parse(session.state.since) ? [...session.segments, { start: session.state.since, end: iso(end) }] : session.segments;
}
export function unionSegments(segments: StudySegment[]): StudySegment[] {
  const merged: StudySegment[] = [];
  for (const interval of [...segments].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const previous = merged.at(-1);
    if (previous && Date.parse(interval.start) <= Date.parse(previous.end)) previous.end = iso(Math.max(Date.parse(previous.end), Date.parse(interval.end)));
    else merged.push({ ...interval });
  }
  return merged;
}
export function durationMs(segments: StudySegment[]): number {
  return unionSegments(segments).reduce((total, segment) => total + Date.parse(segment.end) - Date.parse(segment.start), 0);
}
export function weekStartAt(now: number, timeZone: string): string {
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate();
  return date.subtract({ days: date.dayOfWeek - 1 }).toString();
}
export function shiftStudyDate(date: string, days: number): string { return Temporal.PlainDate.from(date).add({ days }).toString(); }
export function localStudyInstant(date: string, time: string, timeZone: string): string {
  return Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timeZone, { disambiguation: 'reject' }).toInstant().toString({ fractionalSecondDigits: 3 });
}
export function studyDayBounds(date: string, timeZone: string): { start: number; end: number } {
  const start = Temporal.PlainDate.from(date).toZonedDateTime(timeZone);
  return { start: start.epochMilliseconds, end: start.add({ days: 1 }).epochMilliseconds };
}
export function clipSegments(segments: StudySegment[], start: number, end: number): StudySegment[] {
  return segments.flatMap(segment => {
    const a = Math.max(start, Date.parse(segment.start)), b = Math.min(end, Date.parse(segment.end));
    return b > a ? [{ start: iso(a), end: iso(b) }] : [];
  });
}
export function weeklyStudy(sessions: StudySession[], weekStart: string, timeZone: string, now: number) {
  const start = studyDayBounds(weekStart, timeZone).start, end = studyDayBounds(shiftStudyDate(weekStart, 7), timeZone).start;
  const entries = sessions.filter(session => !session.deletedAt).map(session => ({ session, segments: clipSegments(sessionSegments(session, now), start, end) })).filter(entry => entry.segments.length > 0);
  const segments = unionSegments(entries.flatMap(entry => entry.segments));
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftStudyDate(weekStart, index), bounds = studyDayBounds(date, timeZone);
    return { date, durationMs: durationMs(clipSegments(segments, bounds.start, bounds.end)) };
  });
  // Attribute overlapping imported records once, to the earliest created record, consistently on every device.
  const subjects = new Map<string | null, number>();
  const occupied: StudySegment[] = [];
  for (const entry of entries.sort((a, b) => a.session.createdAt.localeCompare(b.session.createdAt) || a.session.id.localeCompare(b.session.id))) {
    const before = durationMs(occupied);
    occupied.push(...entry.segments);
    const credited = durationMs(occupied) - before;
    subjects.set(entry.session.subjectId, (subjects.get(entry.session.subjectId) ?? 0) + credited);
  }
  return { durationMs: durationMs(segments), days, subjects: [...subjects].map(([subjectId, durationMs]) => ({ subjectId, durationMs })), entries: entries.map(entry => entry.session) };
}
