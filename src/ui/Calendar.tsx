import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../data/client';
import type { Snapshot, StudyEvent } from '../../shared/schema';
import { useApp } from './context';
import { addDays, formatTime, fromDateKey, longDay, relativeDay, toDateKey, todayKey } from './format';
import { subjectTint } from './icons';

type DayItem =
  | { kind: 'event'; id: string; title: string; done: boolean; color?: string; time: string | null; event: StudyEvent }
  | { kind: 'assignment'; id: string; title: string; done: boolean; color?: string; status: string; type: 'work' | 'todo' };

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function itemsByDay(state: Snapshot): Map<string, DayItem[]> {
  const color = (id: string | null) => state.subjects.find((subject) => subject.id === id)?.color;
  const map = new Map<string, DayItem[]>();
  const push = (key: string, item: DayItem) => map.set(key, [...(map.get(key) ?? []), item]);
  for (const event of state.events) {
    push(event.date.slice(0, 10), { kind: 'event', id: event.id, title: event.title, done: Boolean(event.completedAt), color: color(event.subjectId), time: event.time, event });
  }
  const linked = new Set(state.events.map(event => event.organatoId).filter(Boolean));
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

function ItemRow({ item }: { item: DayItem }) {
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
          await act(() => api.completeEvent(item.id, event.target.checked));
          setBusy(false);
        }}
      />
      <span className="todo__text">
        <span className="todo__title">{item.title}</span>
        {item.time || item.event.notes ? <span className="todo__detail">{[formatTime(item.time), item.event.notes].filter(Boolean).join(', ')}</span> : null}
      </span>
    </li>
  );
}

export function CalendarPage() {
  const { state, openEventDialog } = useApp();
  const today = todayKey();
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => fromDateKey(today.slice(0, 8) + '01'));
  const grid = useRef<HTMLDivElement>(null);
  const focusAfterMove = useRef(false);
  const byDay = useMemo(() => itemsByDay(state), [state]);
  const days = useMemo(() => monthGrid(month), [month]);
  const monthKey = toDateKey(month).slice(0, 7);

  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${selected}"]`)?.focus();
  }, [selected, days]);

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
    () => state.events.filter((event) => !event.completedAt && event.date < today).sort((a, b) => a.date.localeCompare(b.date)),
    [state.events, today],
  );

  return (
    <div className="split split--calendar">
      <div className="page page--wide">
        <header className="calendar-head">
          <h1 className="page__title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1>
          <div className="calendar-head__actions">
            <button type="button" className="button button--quiet button--small" onClick={() => select(today, true)}>Today</button>
            <button type="button" className="icon-button" aria-label="Previous month" onClick={() => shiftMonth(-1)}><ChevronLeft size={17} /></button>
            <button type="button" className="icon-button" aria-label="Next month" onClick={() => shiftMonth(1)}><ChevronRight size={17} /></button>
            <button type="button" className="button button--small" onClick={() => openEventDialog(selected)}><Plus size={14} /> New event</button>
          </div>
        </header>
        {!state.settings.organatoConnected ? (
          <p className="calendar-note">Connect Organato in Settings to save calendar entries and see assignment due dates.</p>
        ) : null}
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
                          <span key={item.id} className={`month__chip month__chip--${item.kind}${item.done ? ' is-done' : ''}`} style={subjectTint(item.color)}>
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
      </div>
      <aside className="inspector" aria-label="To do">
        <section className="inspector__section" aria-labelledby="day-heading">
          <div className="inspector__heading-row">
            <h2 className="inspector__heading" id="day-heading">{selected === today ? 'Today' : longDay(selected)}</h2>
            <button type="button" className="icon-button icon-button--small" aria-label={`Add event on ${longDay(selected)}`} onClick={() => openEventDialog(selected)}><Plus size={15} /></button>
          </div>
          {selectedItems.length === 0 ? <p className="inspector__empty">Nothing on this day.</p> : <ul className="todos">{selectedItems.map((item) => <ItemRow key={item.id} item={item} />)}</ul>}
        </section>
        {overdue.length > 0 && selected === today ? (
          <section className="inspector__section" aria-labelledby="overdue-heading">
            <h2 className="inspector__heading" id="overdue-heading">Still open</h2>
            <ul className="todos">
              {overdue.slice(0, 6).map((event) => (
                <ItemRow key={event.id} item={{ kind: 'event', id: event.id, title: `${event.title} (${relativeDay(event.date).toLowerCase()})`, done: false, time: event.time, event, color: state.subjects.find((s) => s.id === event.subjectId)?.color }} />
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
                <ul className="todos">{day.items.map((item) => <ItemRow key={item.id} item={item} />)}</ul>
              </div>
            ))
          )}
        </section>
      </aside>
    </div>
  );
}
