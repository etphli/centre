import { Temporal } from '@js-temporal/polyfill';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../data/client';
import type { Snapshot, StudyEvent } from '../../shared/schema';
import {
  addCalendarDays, aggregateCalendarWeek, calendarDateLabel, calendarTimeLabel, calendarTodayKey, calendarWeekStart,
  eventInterval, type WeekDeadline, type WeekSession,
} from '../../shared/calendar-time';
import { useApp } from './context';
import { EventDialog, RemoveEventDialog } from './Dialogs';
import { addDays, formatTime, fromDateKey, longDay, relativeDay, toDateKey } from './format';
import { subjectTint } from './icons';
import './calendar.css';

type DayItem =
  | { kind: 'event'; id: string; title: string; done: boolean; color?: string; time: string | null; event: StudyEvent }
  | { kind: 'assignment'; id: string; title: string; done: boolean; color?: string; status: string; type: 'work' | 'todo' };

type CalendarView = 'month' | 'week';

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_PX = 56;
/** Shortest drawn block, so a 15-minute plan still has a readable, clickable row. */
const MIN_BLOCK_PX = 24;
const DAY_MINUTES = 24 * 60;
const STUDY_HOURS_START = 7;
const VIEW_KEY = 'centre.calendar.view';

const activeEvents = (state: Snapshot) => state.events.filter((event) => !event.deletedAt);
const isPlannedSession = (event: StudyEvent) => event.origin === 'centre' && event.kind === 'session' && !event.deletedAt;

function itemsByDay(state: Snapshot): Map<string, DayItem[]> {
  const color = (id: string | null) => state.subjects.find((subject) => subject.id === id)?.color;
  const map = new Map<string, DayItem[]>();
  const push = (key: string, item: DayItem) => map.set(key, [...(map.get(key) ?? []), item]);
  const events = activeEvents(state);
  for (const event of events) {
    push(event.date.slice(0, 10), { kind: 'event', id: event.id, title: event.title, done: Boolean(event.completedAt), color: color(event.subjectId), time: event.time, event });
  }
  const linked = new Set(events.map(event => event.organatoId).filter(Boolean));
  for (const item of state.assignments) {
    if (linked.has(item.id)) continue;
    if (!item.dueDate) continue;
    push(item.dueDate.slice(0, 10), { kind: 'assignment', id: item.id, title: item.title, done: /done|complete|submitted/i.test(item.status), color: color(item.subjectId), status: item.status, type: item.kind });
  }
  for (const list of map.values()) list.sort((a, b) => Number(a.done) - Number(b.done) || (a.kind === 'event' && b.kind === 'event' ? (a.time ?? '').localeCompare(b.time ?? '') : 0));
  return map;
}

function monthGrid(month: Date): string[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = toDateKey(new Date(first.getFullYear(), first.getMonth(), 1 - offset));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function clockMinutes(time: string | null): number | null {
  const match = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const minutePx = (minute: number) => (minute / 60) * HOUR_PX;

/**
 * The grid is a wall-clock axis, so the shared hour labels are exact on every day. On a
 * daylight-saving day the changed hour is marked: skipped clock time, or an hour that happens twice.
 */
function clockChange(date: string, timeZone: string, dayLengthMinutes: number): { fromMinute: number; toMinute: number; kind: 'skip' | 'repeat' } | null {
  if (dayLengthMinutes === DAY_MINUTES) return null;
  const transition = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone }).getTimeZoneTransition('next');
  if (!transition || transition.toPlainDate().toString() !== date) return null;
  const after = transition.hour * 60 + transition.minute;
  const shift = Math.abs(dayLengthMinutes - DAY_MINUTES);
  return dayLengthMinutes < DAY_MINUTES
    ? { fromMinute: after - shift, toMinute: after, kind: 'skip' }
    : { fromMinute: after, toMinute: after + shift, kind: 'repeat' };
}

const hourLabel = (hour: number) => calendarTimeLabel(`${String(hour).padStart(2, '0')}:00`, { hour: 'numeric' });

/** Wall-clock label for an instant in the calendar's time zone. */
function instantTime(instant: Temporal.Instant, timeZone: string): string {
  return calendarTimeLabel(instant.toZonedDateTimeISO(timeZone).toPlainTime().toString().slice(0, 5));
}

function sessionRange(event: StudyEvent, timeZone: string): { start: string; end: string; endDate: string } | null {
  const interval = eventInterval(event, timeZone);
  if (!interval) return null;
  return {
    start: instantTime(interval.start, timeZone),
    end: instantTime(interval.end, timeZone),
    endDate: interval.end.toZonedDateTimeISO(timeZone).toPlainDate().toString(),
  };
}

function weekTitle(weekStart: string): string {
  const format = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return format.formatRange(fromDateKey(weekStart), fromDateKey(addCalendarDays(weekStart, 6)));
}

function ItemRow({ item, onOpen }: { item: DayItem; onOpen: (id: string) => void }) {
  const { act } = useApp();
  const [busy, setBusy] = useState(false);
  if (item.kind === 'assignment') {
    return (
      <li className={`todo${item.done ? ' is-done' : ''}`} style={subjectTint(item.color)}>
        <span className="todo__dot" aria-hidden />
        <span className="todo__text">
          <span className="todo__title">{item.title}</span>
          <span className="todo__detail">{item.type === 'todo' ? 'Organato to do' : 'Organato assignment'}, {item.status}</span>
        </span>
      </li>
    );
  }
  const planned = isPlannedSession(item.event) ? item.event.plannedDurationMinutes : null;
  return (
    <li className={`todo${item.done ? ' is-done' : ''}`} style={subjectTint(item.color)}>
      <input
        type="checkbox"
        className="todo__check"
        checked={item.done}
        disabled={busy}
        aria-label={`${item.done ? 'Mark not done' : 'Mark done'}: ${item.title}`}
        onChange={async (event) => {
          setBusy(true);
          await act(() => api.completeEvent(item.id, event.target.checked, item.event.revision));
          setBusy(false);
        }}
      />
      <span className="todo__text">
        <button type="button" className="todo__title todo__open" onClick={() => onOpen(item.id)}>{item.title}</button>
        {item.time || planned || item.event.notes ? (
          <span className="todo__detail">{[formatTime(item.time), planned ? `${minutesLabel(planned)} planned` : '', item.event.notes].filter(Boolean).join(', ')}</span>
        ) : null}
      </span>
    </li>
  );
}

function EventDetails({ event, timeZone, overlaps, onClose, onEdit, onRemove }: {
  event: StudyEvent;
  timeZone: string;
  overlaps: StudyEvent[];
  onClose: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { state, act } = useApp();
  const [busy, setBusy] = useState(false);
  const subject = state.subjects.find((item) => item.id === event.subjectId);
  const planned = isPlannedSession(event);
  const range = planned ? sessionRange(event, timeZone) : null;
  const done = Boolean(event.completedAt);
  const dateLabel = calendarDateLabel(event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const source = event.origin === 'organato' ? 'From Organato' : planned ? 'Planned study session' : 'Centre event';

  return (
    <section className="inspector__section event-details" aria-labelledby="event-details-heading" style={subjectTint(subject?.color)}>
      <div className="inspector__heading-row">
        <span className="event-details__source">{source}</span>
        <button type="button" className="icon-button icon-button--small" aria-label="Close details" onClick={onClose}><X size={14} /></button>
      </div>
      <h2 className="event-details__title" id="event-details-heading">{event.title}</h2>
      <dl className="event-details__facts">
        <dt>Date</dt>
        <dd>{dateLabel}</dd>
        <dt>Time</dt>
        <dd>
          {range ? `${range.start} to ${range.end}${range.endDate !== event.date ? ` (${calendarDateLabel(range.endDate, { weekday: 'short' })})` : ''}` : event.time ? formatTime(event.time) : 'All day'}
          <span className="event-details__zone">{timeZone}</span>
        </dd>
        {planned && event.plannedDurationMinutes ? (
          <>
            <dt>Planned</dt>
            <dd>{minutesLabel(event.plannedDurationMinutes)}<span className="event-details__zone">A plan, not logged study time</span></dd>
          </>
        ) : null}
        {subject ? (<><dt>Subject</dt><dd>{subject.name}</dd></>) : null}
        {event.notes ? (<><dt>Notes</dt><dd className="event-details__notes">{event.notes}</dd></>) : null}
      </dl>
      {overlaps.length ? (
        <p className="event-details__overlap" role="note">
          Overlaps {overlaps.map((item) => item.title).join(', ')}.
        </p>
      ) : null}
      <label className="event-details__done">
        <input
          type="checkbox"
          checked={done}
          disabled={busy}
          onChange={async (change) => {
            setBusy(true);
            await act(() => api.completeEvent(event.id, change.target.checked, event.revision));
            setBusy(false);
          }}
        />
        Done
      </label>
      {planned ? (
        <>
          <div className="event-details__actions">
            <button type="button" className="button button--small" onClick={onEdit}><Pencil size={13} /> Edit or move</button>
            <button type="button" className="button button--small button--quiet event-details__remove" onClick={onRemove}><Trash2 size={13} /> Remove</button>
          </div>
          <p className="event-details__hint">Done keeps the session on your calendar. Remove takes the plan off it. Neither changes your Log hours, assignments or due dates.</p>
        </>
      ) : event.origin === 'organato' ? (
        <p className="event-details__hint">Organato owns this item. Change it in Organato.</p>
      ) : null}
    </section>
  );
}

function SessionBlock({ session, color, selected, timeZone, onOpen }: {
  session: WeekSession;
  color?: string;
  selected: boolean;
  timeZone: string;
  onOpen: () => void;
}) {
  // Wall-clock placement matches the hour labels; the label and planned duration stay elapsed-time accurate.
  const top = minutePx(session.startMinute);
  const height = Math.max(MIN_BLOCK_PX, minutePx(session.endMinute - session.startMinute));
  // Overlaps sit in side-by-side lanes so each block has its own, unobstructed hit area.
  const lanePercent = 100 / session.laneCount;
  const continues = session.continuesIntoNextDay;
  const start = instantTime(session.start, timeZone);
  const end = instantTime(session.end, timeZone);
  const done = Boolean(session.event.completedAt);
  const label = [
    session.event.title,
    `${start} to ${end}`,
    `${minutesLabel(session.plannedDurationMinutes)} planned`,
    done ? 'done' : '',
    session.overlapIds.length ? `overlaps ${session.overlapIds.length} other session${session.overlapIds.length === 1 ? '' : 's'}` : '',
    session.continuesFromPreviousDay ? 'continues from the previous day' : '',
    continues ? 'continues into the next day' : '',
  ].filter(Boolean).join(', ');
  return (
    <li
      className={`week__slot${selected ? ' is-selected' : ''}`}
      data-session-id={session.event.id}
      style={{ top: `${top}px`, height: `${height}px`, left: `calc(${session.lane * lanePercent}% + 2px)`, width: `calc(${lanePercent}% - 4px)` }}
    >
      <button
        type="button"
        className={`session${done ? ' is-done' : ''}${selected ? ' is-selected' : ''}${session.overlapIds.length ? ' is-overlap' : ''}${height < 38 ? ' is-short' : height < 50 ? ' is-compact' : ''}${continues ? ' is-clipped-end' : ''}${session.continuesFromPreviousDay ? ' is-clipped-start' : ''}`}
        style={subjectTint(color)}
        aria-label={label}
        title={label}
        aria-pressed={selected}
        onClick={onOpen}
      >
        <span className="session__title">{session.event.title}</span>
        <span className="session__time">{start} to {end}</span>
        {session.overlapIds.length && height >= 70 ? <span className="session__flag">Overlaps</span> : null}
      </button>
    </li>
  );
}

function WeekGrid({ weekStart, selected, today, timeZone, openId, onSelectDay, onOpen }: {
  weekStart: string;
  selected: string;
  today: string;
  timeZone: string;
  openId: string | null;
  onSelectDay: (key: string, focus?: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const { state, openEventDialog } = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  const color = (id: string | null) => state.subjects.find((subject) => subject.id === id)?.color;
  const days = useMemo(
    () => aggregateCalendarWeek({ weekStart, timeZone, events: state.events, assignments: state.assignments }),
    [state, weekStart, timeZone],
  );
  const [now, setNow] = useState(() => Temporal.Now.zonedDateTimeISO(timeZone));
  useEffect(() => {
    setNow(Temporal.Now.zonedDateTimeISO(timeZone));
    const timer = window.setInterval(() => setNow(Temporal.Now.zonedDateTimeISO(timeZone)), 60_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);

  // Open on the first planned session of the week, or the start of a usual study day when there are none.
  const starts = days.flatMap((day) => day.sessions.filter((session) => !session.continuesFromPreviousDay).map((session) => session.startMinute));
  const earliest = starts.length ? Math.min(...starts) - 60 : STUDY_HOURS_START * 60;
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, minutePx(Math.floor(earliest / 60) * 60) - HOUR_PX / 2);
    // Scroll only when the week changes, not on every snapshot refresh.
  }, [weekStart]);

  const selectedEvent = state.events.find(event => event.id === openId);
  useLayoutEffect(() => {
    const root = scroller.current;
    const slot = openId ? root?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(openId)}"]`) : null;
    if (!root || !slot) return;
    const viewport = root.getBoundingClientRect();
    const block = slot.getBoundingClientRect();
    const visibleTop = viewport.top + (root.querySelector('.week__sticky')?.getBoundingClientRect().height ?? 0) + 8;
    const visibleBottom = viewport.bottom - 8;
    if (block.top < visibleTop || block.height > visibleBottom - visibleTop) root.scrollTop += block.top - visibleTop;
    else if (block.bottom > visibleBottom) root.scrollTop += block.bottom - visibleBottom;
  }, [openId,weekStart,selectedEvent?.startAt,selectedEvent?.plannedDurationMinutes]);

  function onHeadKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const step = moves[event.key];
    if (step !== undefined) {
      event.preventDefault();
      onSelectDay(addCalendarDays(selected, step), true);
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      openEventDialog(selected);
    }
  }

  const nowMinute = now.hour * 60 + now.minute;
  // Days with overlapping plans get wider columns, so side-by-side lanes keep readable titles.
  const lanes = days.map((day) => Math.min(3, Math.max(1, ...day.sessions.map((session) => session.laneCount))));
  const rowStyle = {gridTemplateColumns:`var(--gutter) ${lanes.map(count => `minmax(0, ${count}fr)`).join(' ')}`};
  const nowDate = now.toPlainDate().toString();

  return (
    <div className="week" ref={scroller} role="region" aria-label={`Week of ${calendarDateLabel(weekStart, { day: 'numeric', month: 'long' })}, times in ${timeZone}`} tabIndex={-1}>
      <div className="week__inner">
        <div className="week__sticky">
          <div className="week__row week__row--head" style={rowStyle} role="toolbar" aria-label="Days" onKeyDown={onHeadKey}>
            <span className="week__corner" aria-hidden />
            {days.map((day) => {
              const isSelected = day.date === selected;
              const count = day.sessions.length + day.deadlines.length;
              return (
                <button
                  key={day.date}
                  type="button"
                  data-date={day.date}
                  tabIndex={isSelected ? 0 : -1}
                  aria-pressed={isSelected}
                  aria-current={day.date === today ? 'date' : undefined}
                  aria-label={`${calendarDateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}${day.dayLengthMinutes !== DAY_MINUTES ? `, daylight saving, ${Math.round(day.dayLengthMinutes / 60)} hour day` : ''}${count ? `, ${count} item${count === 1 ? '' : 's'}` : ''}`}
                  className={`week__day${isSelected ? ' is-selected' : ''}${day.date === today ? ' is-today' : ''}`}
                  onClick={() => onSelectDay(day.date)}
                  onDoubleClick={() => openEventDialog(day.date)}
                >
                  <span className="week__weekday">{calendarDateLabel(day.date, { weekday: 'short' })}</span>
                  <span className="week__date">{calendarDateLabel(day.date, { day: 'numeric' })}</span>
                  {day.dayLengthMinutes !== DAY_MINUTES ? <span className="week__dst">{Math.round(day.dayLengthMinutes / 60)} h day</span> : null}
                </button>
              );
            })}
          </div>
          <div className="week__row week__row--due" style={rowStyle}>
            <span className="week__gutter-label">Due</span>
            {days.map((day) => (
              <ul key={day.date} className="week__due" aria-label={`Due ${calendarDateLabel(day.date, { weekday: 'long' })}`}>
                {day.deadlines.map((deadline) => (
                  <DueChip key={deadline.id} deadline={deadline} color={color(deadline.subjectId)} selected={openId === deadline.id} onOpen={onOpen} />
                ))}
              </ul>
            ))}
          </div>
        </div>
        <div className="week__row week__row--body" style={{ ...rowStyle,height: `${24 * HOUR_PX}px` }}>
          <ol className="week__hours" aria-hidden>
            {Array.from({ length: 24 }, (_, hour) => (
              <li key={hour} style={{ top: `${hour * HOUR_PX}px` }}>{hour ? hourLabel(hour) : ''}</li>
            ))}
          </ol>
          {days.map((day) => (
            <div
              key={day.date}
              className={`week__column${day.date === selected ? ' is-selected' : ''}${day.date === today ? ' is-today' : ''}`}
              onDoubleClick={(event) => { if (event.target === event.currentTarget) openEventDialog(day.date); }}
            >
              {(() => {
                const change = clockChange(day.date, timeZone, day.dayLengthMinutes);
                if (!change) return null;
                const from = hourLabel(Math.floor(change.fromMinute / 60));
                const to = hourLabel(Math.floor(change.toMinute / 60) % 24);
                const text = change.kind === 'skip' ? `Clocks skip ${from} to ${to}` : `${from} to ${to} happens twice`;
                return (
                  <span className={`week__clock-change week__clock-change--${change.kind}`} style={{ top: `${minutePx(change.fromMinute)}px`, height: `${minutePx(change.toMinute - change.fromMinute)}px` }}>
                    {text}
                  </span>
                );
              })()}
              {day.deadlines.map((deadline) => {
                const minute = clockMinutes(deadline.time);
                return minute === null ? null : (
                  <span key={deadline.id} className="week__due-line" style={{ top: `${minutePx(minute)}px`, ...subjectTint(color(deadline.subjectId)) }} aria-hidden title={`${deadline.title} due ${formatTime(deadline.time)}`} />
                );
              })}
              <ol className="week__sessions" aria-label={`Planned sessions, ${calendarDateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}`}>
                {day.sessions.map((session) => (
                  <SessionBlock
                    key={session.event.id}
                    session={session}
                    color={color(session.event.subjectId)}
                    selected={openId === session.event.id}
                    timeZone={timeZone}
                    onOpen={() => onOpen(session.event.id)}
                  />
                ))}
              </ol>
              {day.date === nowDate ? <span className="week__now" style={{ top: `${minutePx(nowMinute)}px` }} aria-hidden /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DueChip({ deadline, color, selected, onOpen }: { deadline: WeekDeadline; color?: string; selected: boolean; onOpen: (id: string) => void }) {
  const what = deadline.assignment ? (deadline.assignment.kind === 'todo' ? 'Organato to do' : 'Organato assignment') : deadline.event?.origin === 'organato' ? 'Organato' : 'Centre';
  const when = deadline.time ? formatTime(deadline.time) : 'all day';
  const label = `${deadline.title}, ${when}, ${what}${deadline.done ? ', done' : ''}`;
  const content = (
    <>
      {deadline.time ? <span className="due-chip__time">{formatTime(deadline.time)}</span> : null}
      <span className="due-chip__title">{deadline.title}</span>
    </>
  );
  return (
    <li>
      {deadline.event ? (
        <button type="button" className={`due-chip${deadline.done ? ' is-done' : ''}${selected ? ' is-selected' : ''}`} style={subjectTint(color)} aria-label={label} aria-pressed={selected} onClick={() => onOpen(deadline.id)}>
          {content}
        </button>
      ) : (
        <span className={`due-chip due-chip--assignment${deadline.done ? ' is-done' : ''}`} style={subjectTint(color)} title={label}>{content}</span>
      )}
    </li>
  );
}

export function CalendarPage() {
  const { state, openEventDialog } = useApp();
  const timeZone = state.settings.timeZone;
  const today = calendarTodayKey(timeZone);
  const [view, setView] = useState<CalendarView>(() => (localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'month'));
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => fromDateKey(today.slice(0, 8) + '01'));
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<StudyEvent | null>(null);
  const [removing, setRemoving] = useState<StudyEvent | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const weekRef = useRef<HTMLDivElement>(null);
  const focusAfterMove = useRef(false);
  const byDay = useMemo(() => itemsByDay(state), [state]);
  const days = useMemo(() => monthGrid(month), [month]);
  const monthKey = toDateKey(month).slice(0, 7);
  const weekStart = calendarWeekStart(selected);
  const openEvent = openId ? state.events.find((event) => event.id === openId && !event.deletedAt) ?? null : null;

  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    const root = view === 'month' ? grid.current : weekRef.current;
    root?.querySelector<HTMLButtonElement>(`[data-date="${selected}"]`)?.focus();
  }, [selected, days, view]);

  function select(key: string, focus = false) {
    focusAfterMove.current = focus;
    setSelected(key);
    if (key.slice(0, 7) !== monthKey) setMonth(fromDateKey(key.slice(0, 8) + '01'));
  }

  function shiftMonth(step: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + step, 1);
    setMonth(next);
    setSelected(toDateKey(next));
  }

  function shift(step: number) {
    if (view === 'month') shiftMonth(step);
    else select(addCalendarDays(selected, step * 7));
  }

  function openItem(id:string) {
    const event = state.events.find(event => event.id === id);
    if (view === 'week' && event && !aggregateCalendarWeek({weekStart,timeZone,events:[event],assignments:[]}).some(day => day.sessions.length || day.deadlines.length)) select(event.startAt ? Temporal.Instant.from(event.startAt).toZonedDateTimeISO(timeZone).toPlainDate().toString() : event.date);
    setOpenId(id);
  }

  function onGridKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const step = moves[event.key];
    if (step !== undefined) {
      event.preventDefault();
      select(addDays(selected, step), true);
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      openEventDialog(selected);
    }
  }

  const overlapsFor = (event: StudyEvent): StudyEvent[] => {
    if (!isPlannedSession(event)) return [];
    const week = aggregateCalendarWeek({ weekStart: calendarWeekStart(event.date), timeZone, events: state.events, assignments: [] });
    const ids = new Set(week.flatMap((day) => day.sessions.filter((item) => item.event.id === event.id).flatMap((item) => item.overlapIds)));
    return [...ids].map((id) => state.events.find((item) => item.id === id)).filter((item): item is StudyEvent => Boolean(item));
  };

  const selectedItems = byDay.get(selected) ?? [];
  const upcoming = useMemo(() => {
    const out: { key: string; items: DayItem[] }[] = [];
    for (let offset = 1; offset <= 14; offset += 1) {
      const key = addDays(selected, offset);
      const items = (byDay.get(key) ?? []).filter((item) => !item.done);
      if (items.length) out.push({ key, items });
    }
    return out;
  }, [byDay, selected]);
  const overdue = useMemo(
    () => activeEvents(state).filter((event) => !event.completedAt && event.date < today).sort((a, b) => a.date.localeCompare(b.date)),
    [state, today],
  );
  const color = (id: string | null) => state.subjects.find((subject) => subject.id === id)?.color;

  return (
    <div className="split split--calendar">
      <div className={`page page--wide${view === 'week' ? ' calendar-page--week' : ''}`}>
        <header className="calendar-head">
          <h1 className="page__title">
            {view === 'month' ? month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : weekTitle(weekStart)}
          </h1>
          <div className="calendar-head__actions">
            <div className="segmented calendar-view" role="radiogroup" aria-label="Calendar view">
              {(['month', 'week'] as const).map((option) => (
                <label key={option} className={`segmented__option${view === option ? ' is-selected' : ''}`}>
                  <input type="radio" name="calendar-view" value={option} checked={view === option} onChange={() => setView(option)} />
                  {option === 'month' ? 'Month' : 'Week'}
                </label>
              ))}
            </div>
            <button type="button" className="button button--quiet button--small" onClick={() => select(today, true)}>
              {view === 'month' ? 'Today' : 'This week'}
            </button>
            <button type="button" className="icon-button" aria-label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => shift(-1)}><ChevronLeft size={17} /></button>
            <button type="button" className="icon-button" aria-label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => shift(1)}><ChevronRight size={17} /></button>
            <button type="button" className="button button--small" onClick={() => openEventDialog(selected)}><Plus size={14} /> New event</button>
          </div>
        </header>
        {!state.settings.organatoConnected ? (
          <p className="calendar-note">Connect Organato in Settings to save calendar entries and see assignment due dates.</p>
        ) : null}
        {state.syncError ? <p className="calendar-note calendar-note--alert" role="alert">{state.syncError}</p> : null}
        {view === 'month' ? (
          <>
            <div className="month" role="grid" aria-label="Month" ref={grid} onKeyDown={onGridKey}>
              <div className="month__row month__row--head" role="row">
                {weekdays.map((day) => <span key={day} role="columnheader" className="month__weekday">{day}</span>)}
              </div>
              {Array.from({ length: 6 }, (_, week) => (
                <div key={week} className="month__row" role="row">
                  {days.slice(week * 7, week * 7 + 7).map((key) => {
                    const items = byDay.get(key) ?? [];
                    const outside = key.slice(0, 7) !== monthKey;
                    const isSelected = key === selected;
                    return (
                      <div key={key} role="gridcell" aria-selected={isSelected} className="month__cell-wrap">
                        <button
                          type="button"
                          data-date={key}
                          tabIndex={isSelected ? 0 : -1}
                          className={`month__cell${outside ? ' is-outside' : ''}${isSelected ? ' is-selected' : ''}${key === today ? ' is-today' : ''}`}
                          aria-label={`${longDay(key)}${items.length ? `, ${items.length} item${items.length === 1 ? '' : 's'}` : ''}`}
                          onClick={() => select(key)}
                          onDoubleClick={() => openEventDialog(key)}
                        >
                          <span className="month__date">{fromDateKey(key).getDate()}</span>
                          <span className="month__items" aria-hidden>
                            {items.slice(0, 3).map((item) => (
                              <span key={item.id} className={`month__chip month__chip--${item.kind}${item.kind === 'event' && isPlannedSession(item.event) ? ' month__chip--session' : ''}${item.done ? ' is-done' : ''}`} style={subjectTint(item.color)}>
                                {item.title}
                              </span>
                            ))}
                            {items.length > 3 ? <span className="month__more">{items.length - 3} more</span> : null}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="cards__hint">Arrow keys move between days. Double-click a day, or press Shift+Enter, to add an event.</p>
          </>
        ) : (
          <>
            <p className="calendar-zone">Times in {timeZone}. Planned sessions show when you mean to study; they are not added to your Log.</p>
            <div ref={weekRef}>
              <WeekGrid
                weekStart={weekStart}
                selected={selected}
                today={today}
                timeZone={timeZone}
                openId={openId}
                onSelectDay={select}
                onOpen={openItem}
              />
            </div>
            <p className="cards__hint">Arrow keys on the day headers move between days. Double-click a day, or press Shift+Enter, to plan a session. Select a session to edit, move or remove it.</p>
          </>
        )}
      </div>
      <aside className="inspector" aria-label="To do">
        {openEvent ? (
          <EventDetails
            key={openEvent.id}
            event={openEvent}
            timeZone={timeZone}
            overlaps={overlapsFor(openEvent)}
            onClose={() => setOpenId(null)}
            onEdit={() => setEditing(openEvent)}
            onRemove={() => setRemoving(openEvent)}
          />
        ) : null}
        <section className="inspector__section" aria-labelledby="day-heading">
          <div className="inspector__heading-row">
            <h2 className="inspector__heading" id="day-heading">{selected === today ? 'Today' : longDay(selected)}</h2>
            <button type="button" className="icon-button icon-button--small" aria-label={`Add event on ${longDay(selected)}`} onClick={() => openEventDialog(selected)}><Plus size={15} /></button>
          </div>
          {selectedItems.length === 0 ? <p className="inspector__empty">Nothing on this day.</p> : <ul className="todos">{selectedItems.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)}</ul>}
        </section>
        {overdue.length > 0 && selected === today ? (
          <section className="inspector__section" aria-labelledby="overdue-heading">
            <h2 className="inspector__heading" id="overdue-heading">Still open</h2>
            <ul className="todos">
              {overdue.slice(0, 6).map((event) => (
                <ItemRow key={event.id} onOpen={openItem} item={{ kind: 'event', id: event.id, title: `${event.title} (${relativeDay(event.date).toLowerCase()})`, done: false, time: event.time, event, color: color(event.subjectId) }} />
              ))}
            </ul>
          </section>
        ) : null}
        <section className="inspector__section" aria-labelledby="next-heading">
          <h2 className="inspector__heading" id="next-heading">Next two weeks</h2>
          {upcoming.length === 0 ? (
            <p className="inspector__empty">Clear for now. Type <kbd>/plan</kbd> below to schedule study sessions.</p>
          ) : (
            upcoming.map((day) => (
              <div key={day.key} className="todo-day">
                <button type="button" className="todo-day__label" onClick={() => select(day.key)}>{relativeDay(day.key)}</button>
                <ul className="todos">{day.items.map((item) => <ItemRow key={item.id} item={item} onOpen={openItem} />)}</ul>
              </div>
            ))
          )}
        </section>
      </aside>
      {editing ? <EventDialog initialEvent={editing} onClose={() => setEditing(null)} /> : null}
      {removing ? (
        <RemoveEventDialog event={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </div>
  );
}
