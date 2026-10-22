import { Temporal } from '@js-temporal/polyfill';
import { eventSchema, type Assignment, type CalendarEvent, type StudyEvent } from './schema';

/** Converts the canonical planned-event record to the common calendar snapshot projection. */
export function projectCalendarEvent(event: CalendarEvent): StudyEvent {
  return eventSchema.parse(event);
}

/** Replaces one Centre-owned snapshot projection without disturbing Organato projections. */
export function upsertCalendarEventProjection(events: StudyEvent[], event: CalendarEvent): StudyEvent[] {
  const projection = projectCalendarEvent(event);
  return [...events.filter((current) => current.origin !== 'centre' || current.id !== event.id), projection];
}

const dateFromKey = (dateKey: string) => Temporal.PlainDate.from(dateKey);

export function calendarTodayKey(timeZone: string, now: Temporal.Instant = Temporal.Now.instant()): string {
  return now.toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function calendarWeekStart(dateKey: string): string {
  const date = dateFromKey(dateKey);
  return date.subtract({ days: date.dayOfWeek - 1 }).toString();
}

export function calendarWeekDays(weekStartOrDate: string): string[] {
  const start = dateFromKey(calendarWeekStart(weekStartOrDate));
  return Array.from({ length: 7 }, (_, index) => start.add({ days: index }).toString());
}

export function addCalendarDays(dateKey: string, count: number): string {
  return dateFromKey(dateKey).add({ days: count }).toString();
}

export function calendarDateLabel(dateKey: string, options: Intl.DateTimeFormatOptions): string {
  return dateFromKey(dateKey).toLocaleString(undefined, options);
}

export function calendarTimeLabel(time: string, options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }): string {
  return Temporal.PlainTime.from(time).toLocaleString(undefined, options);
}

export function calendarTimeKey(time: Temporal.PlainTime): string {
  return time.second || time.millisecond || time.microsecond || time.nanosecond ? time.toString() : time.toString({smallestUnit:'minute'});
}

export function calendarStartInstant(dateKey: string, time: string, timeZone: string): Temporal.Instant {
  const date = dateFromKey(dateKey);
  const clock = Temporal.PlainTime.from(time);
  return Temporal.ZonedDateTime.from({
    year: date.year, month: date.month, day: date.day, hour: clock.hour, minute: clock.minute, second: clock.second, millisecond: clock.millisecond,
    microsecond: clock.microsecond, nanosecond: clock.nanosecond, timeZone,
  }, { disambiguation: 'reject' }).toInstant();
}

export function eventInterval(event: StudyEvent, fallbackTimeZone = event.timeZone): { start: Temporal.Instant; end: Temporal.Instant } | null {
  if (event.deletedAt || event.kind !== 'session' || !event.plannedDurationMinutes || (!event.startAt && !event.time)) return null;
  try {
    const start = event.startAt ? Temporal.Instant.from(event.startAt) : calendarStartInstant(event.date, event.time ?? '00:00', event.timeZone || fallbackTimeZone);
    return { start, end: start.add({ minutes: event.plannedDurationMinutes }) };
  } catch {
    return null;
  }
}

export interface WeekDeadline {
  id: string;
  title: string;
  kind: 'event' | 'assignment';
  time: string | null;
  done: boolean;
  subjectId: string | null;
  notes: string;
  event?: StudyEvent;
  assignment?: Assignment;
}

export interface WeekSession {
  event: StudyEvent;
  start: Temporal.Instant;
  end: Temporal.Instant;
  /** Wall-clock offsets for the clipped segment. End of day is 1440. */
  startMinute: number;
  endMinute: number;
  /** Full event interval stays in start/end; these are clipped to this day. */
  displayStart: Temporal.Instant;
  displayEnd: Temporal.Instant;
  /** Elapsed offsets from local midnight, for a DST-aware time axis. */
  elapsedStartMinute: number;
  elapsedEndMinute: number;
  durationMinutes: number;
  continuesFromPreviousDay: boolean;
  continuesIntoNextDay: boolean;
  /** Planned duration only. Completion does not turn this into actual study time. */
  plannedDurationMinutes: number;
  overlapIds: string[];
  lane: number;
  laneCount: number;
}

export interface WeekCalendarDay {
  date: string;
  sessions: WeekSession[];
  deadlines: WeekDeadline[];
  dayLengthMinutes: number;
}

function assignLanes(sessions: Omit<WeekSession, 'overlapIds' | 'lane' | 'laneCount'>[]): WeekSession[] {
  const sorted = [...sessions].sort((left, right) => Temporal.Instant.compare(left.displayStart, right.displayStart) || left.event.id.localeCompare(right.event.id));
  const result: WeekSession[] = [];
  let group: typeof sorted = [];
  let groupEnd: Temporal.Instant | null = null;
  const flush = () => {
    if (!group.length) return;
    const laneEnds: Temporal.Instant[] = [];
    const laneById = new Map<string, number>();
    for (const session of group) {
      let lane = laneEnds.findIndex((end) => Temporal.Instant.compare(end, session.displayStart) <= 0);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = session.displayEnd;
      laneById.set(session.event.id, lane);
    }
    const laneCount = laneEnds.length;
    for (const session of group) {
      const overlapIds = group.filter((other) => other.event.id !== session.event.id
        && Temporal.Instant.compare(session.displayStart, other.displayEnd) < 0
        && Temporal.Instant.compare(other.displayStart, session.displayEnd) < 0)
        .map((other) => other.event.id);
      result.push({ ...session, overlapIds, lane: laneById.get(session.event.id) ?? 0, laneCount });
    }
    group = [];
    groupEnd = null;
  };
  for (const session of sorted) {
    if (groupEnd && Temporal.Instant.compare(session.displayStart, groupEnd) >= 0) flush();
    group.push(session);
    if (!groupEnd || Temporal.Instant.compare(session.displayEnd, groupEnd) > 0) groupEnd = session.displayEnd;
  }
  flush();
  return result;
}

/** Collapse revisions before filtering tombstones so stale records cannot reappear. */
function latestEvents(events: StudyEvent[]): StudyEvent[] {
  const latest = new Map<string, StudyEvent>();
  for (const event of events) {
    const key = JSON.stringify([event.origin, event.origin === 'organato' ? event.organatoId ?? event.id : event.id]);
    const current = latest.get(key);
    if (!current || event.revision > current.revision
      || (event.revision === current.revision && (event.updatedAt ?? '') > (current.updatedAt ?? ''))
      || (event.revision === current.revision && event.updatedAt === current.updatedAt && event.deletedAt)) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
}

function deadlinePosition(date: string, time: string | null, startAt: string | null, eventTimeZone: string, timeZone: string): { date: string; time: string | null } | null {
  try {
    if (!startAt && !time) return { date: dateFromKey(date).toString(), time: null };
    const instant = startAt ? Temporal.Instant.from(startAt) : calendarStartInstant(date, time ?? '00:00', eventTimeZone);
    const local = instant.toZonedDateTimeISO(timeZone);
    return { date: local.toPlainDate().toString(), time: local.toPlainTime().toString({ smallestUnit: 'minute' }) };
  } catch {
    return null;
  }
}

export function aggregateCalendarWeek(input: {
  weekStart: string;
  timeZone: string;
  events: StudyEvent[];
  assignments: Assignment[];
}): WeekCalendarDay[] {
  type SessionSegment = Omit<WeekSession, 'overlapIds' | 'lane' | 'laneCount'>;
  const days = calendarWeekDays(input.weekStart).map((date) => {
    const start = dateFromKey(date).toZonedDateTime(input.timeZone).toInstant();
    const end = dateFromKey(date).add({ days: 1 }).toZonedDateTime(input.timeZone).toInstant();
    const sessions: SessionSegment[] = [];
    const deadlines: WeekDeadline[] = [];
    return { date, start, end, sessions, deadlines, dayLengthMinutes: start.until(end).total('minutes') };
  });
  const events = latestEvents(input.events);
  // Tombstoned imports also suppress their assignment fallback to avoid resurrection.
  const linkedItems = new Set(events.flatMap(event => event.organatoId ? [event.organatoId] : event.origin === 'organato' ? [event.id] : []));

  for (const event of events) {
    if (event.deletedAt) continue;
    if (event.kind === 'session' && event.origin === 'centre') {
      const interval = eventInterval(event);
      if (!interval) continue;
      for (const day of days) {
        if (Temporal.Instant.compare(interval.start, day.end) >= 0 || Temporal.Instant.compare(interval.end, day.start) <= 0) continue;
        const continuesFromPreviousDay = Temporal.Instant.compare(interval.start, day.start) < 0;
        const continuesIntoNextDay = Temporal.Instant.compare(interval.end, day.end) > 0;
        const displayStart = continuesFromPreviousDay ? day.start : interval.start;
        const displayEnd = continuesIntoNextDay ? day.end : interval.end;
        const localStart = displayStart.toZonedDateTimeISO(input.timeZone);
        const localEnd = displayEnd.toZonedDateTimeISO(input.timeZone);
        day.sessions.push({
          event, ...interval, displayStart, displayEnd,
          startMinute: localStart.hour * 60 + localStart.minute + localStart.second / 60,
          endMinute: Temporal.Instant.compare(displayEnd, day.end) === 0 ? 1440 : localEnd.hour * 60 + localEnd.minute + localEnd.second / 60,
          elapsedStartMinute: day.start.until(displayStart).total('minutes'),
          elapsedEndMinute: day.start.until(displayEnd).total('minutes'),
          durationMinutes: displayStart.until(displayEnd).total('minutes'),
          continuesFromPreviousDay, continuesIntoNextDay,
          plannedDurationMinutes: event.plannedDurationMinutes ?? 0,
        });
      }
      continue;
    }
    const position = deadlinePosition(event.date, event.time, event.startAt, event.timeZone, input.timeZone);
    const day = days.find(day => day.date === position?.date);
    if (!day || !position) continue;
    day.deadlines.push({
      id: event.id, title: event.title, kind: 'event', time: position.time, done: Boolean(event.completedAt),
      subjectId: event.subjectId, notes: event.notes, event,
    });
  }

  const assignments = new Map<string, Assignment>();
  for (const assignment of input.assignments) {
    const current = assignments.get(assignment.id);
    if (!current || assignment.version > current.version) assignments.set(assignment.id, assignment);
  }
  for (const assignment of assignments.values()) {
    if (!assignment.dueDate || linkedItems.has(assignment.id)) continue;
    const position = deadlinePosition(assignment.dueDate, null, assignment.dueAt ?? (assignment.dueDate.includes('T') ? assignment.dueDate : null), input.timeZone, input.timeZone);
    const day = days.find(day => day.date === position?.date);
    if (!day || !position) continue;
    day.deadlines.push({
      id: assignment.id, title: assignment.title, kind: 'assignment', time: position.time,
      done: /^(done|complete|completed|submitted)$/i.test(assignment.status.trim()), subjectId: assignment.subjectId, notes: '', assignment,
    });
  }

  return days.map(day => {
    day.deadlines.sort((left, right) => Number(left.done) - Number(right.done) || (left.time ?? '').localeCompare(right.time ?? '') || left.title.localeCompare(right.title));
    return { date: day.date, sessions: assignLanes(day.sessions), deadlines: day.deadlines, dayLengthMinutes: day.dayLengthMinutes };
  });
}
