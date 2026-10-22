import { Temporal } from '@js-temporal/polyfill';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatDurationMinutes, withLocalDate, withLocalMinute } from '../../shared/date-time-fields';
import { Select } from './Select';
import './date-time-fields.css';

function FieldPopover({ label, display, children, icon = 'calendar' }: { label: string; display: ReactNode; children: (close: () => void) => ReactNode; icon?: 'calendar' | 'time' }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  function close() { setOpen(false); trigger.current?.focus(); }
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const element = panel.current;
    element.showPopover();
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(icon === 'time' ? 160 : 284, window.innerWidth - 24);
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      const height = Math.min(element.scrollHeight, 340);
      const below = window.innerHeight - rect.bottom - 18, above = rect.top - 18;
      const flip = below < height && above > below;
      const available = Math.max(40, flip ? above : below);
      const visibleHeight = Math.min(height, available);
      element.style.maxHeight = `${visibleHeight}px`;
      element.style.top = `${flip ? rect.top - visibleHeight - 6 : rect.bottom + 6}px`;
    };
    place();
    (element.querySelector<HTMLElement>('[aria-selected="true"]') ?? element.querySelector<HTMLElement>('[data-first-focus]'))?.focus();
    window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    return () => { element.hidePopover(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, icon]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const focus = (event: FocusEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); };
  }, [open]);
  return <div className="centre-date-popover" ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" className={`centre-date-trigger${icon === 'time' ? ' centre-date-trigger--time' : ''}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{display}{icon === 'calendar' ? <CalendarDays size={14} aria-hidden /> : <ChevronDown size={12} aria-hidden />}</button>
    {open ? <div ref={panel} id={id} popover="manual" role="dialog" aria-label={label} className="centre-date-panel">{children(close)}</div> : null}
  </div>;
}

type DateFieldProps = { label: string; value: string; onChange: (date: string) => void };
export function DateField({ label, value, onChange }: DateFieldProps) {
  const date = Temporal.PlainDate.from(value);
  const [month, setMonth] = useState(date.with({ day: 1 }));
  const [focused, setFocused] = useState(value);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setMonth(Temporal.PlainDate.from(value).with({ day: 1 })); setFocused(value); }, [value]);
  const first = month.subtract({ days: month.dayOfWeek - 1 });
  const days = Array.from({ length: 42 }, (_, index) => first.add({ days: index }));
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, day: Temporal.PlainDate) {
    let next: Temporal.PlainDate;
    if (event.key === 'ArrowLeft') next = day.subtract({ days: 1 });
    else if (event.key === 'ArrowRight') next = day.add({ days: 1 });
    else if (event.key === 'ArrowUp') next = day.subtract({ days: 7 });
    else if (event.key === 'ArrowDown') next = day.add({ days: 7 });
    else if (event.key === 'Home') next = day.subtract({ days: day.dayOfWeek - 1 });
    else if (event.key === 'End') next = day.add({ days: 7 - day.dayOfWeek });
    else if (event.key === 'PageUp' || event.key === 'PageDown') next = day.add({ months: event.key === 'PageUp' ? -1 : 1 });
    else return;
    event.preventDefault(); setFocused(next.toString()); setMonth(next.with({ day: 1 }));
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus());
  }
  return <FieldPopover label={label} display={date.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}>{close => <div ref={panel}>
    <div className="centre-date-panel__heading"><button type="button" className="icon-button" aria-label="Previous month" onClick={() => setMonth(value => value.subtract({ months: 1 }))}><ChevronLeft size={14} /></button><span aria-live="polite">{month.toLocaleString('en-AU', { month: 'long', year: 'numeric' })}</span><button type="button" className="icon-button" aria-label="Next month" onClick={() => setMonth(value => value.add({ months: 1 }))}><ChevronRight size={14} /></button></div>
    <div className="centre-date-grid" role="grid" aria-label={month.toLocaleString('en-AU', { month: 'long', year: 'numeric' })}><div role="row" className="centre-date-grid__row">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((name, index) => <span role="columnheader" aria-label={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index]} key={index}>{name}</span>)}</div>{Array.from({ length: 6 }, (_, row) => <div role="row" className="centre-date-grid__row" key={row}>{days.slice(row * 7, row * 7 + 7).map(day => <button type="button" role="gridcell" key={day.toString()} data-date={day.toString()} aria-label={day.toLocaleString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} aria-selected={day.equals(date)} tabIndex={day.toString() === (days.some(day => day.toString() === focused) ? focused : month.toString()) ? 0 : -1} className={day.month !== month.month ? 'is-outside' : undefined} onFocus={() => setFocused(day.toString())} onKeyDown={event => keyboard(event, day)} onClick={() => { onChange(day.toString()); close(); }}>{day.day}</button>)}</div>)}</div>
  </div>}</FieldPopover>;
}

type TimeFieldProps = { label: string; value: string; onChange: (time: string) => void };
export function TimeField({ label, value, onChange }: TimeFieldProps) {
  const minute = Temporal.PlainTime.from(value).toString({ smallestUnit: 'minute' });
  const [draft, setDraft] = useState(minute);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(minute); }, [minute]);
  function change(value: string) {
    setDraft(value);
    const valid = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
    input.current?.setCustomValidity(valid ? '' : 'Use a 24-hour time, such as 19:15.');
    if (valid) onChange(value);
  }
  return <div className="centre-time-field"><input ref={input} aria-label={label} type="text" inputMode="numeric" required pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} placeholder="HH:mm" title="24-hour time, such as 19:15" value={draft} onChange={event => change(event.target.value)} /><FieldPopover label={`${label} suggestions`} display={<span className="visually-hidden">15-minute suggestions</span>} icon="time">{close => <div className="centre-time-options" role="listbox" aria-label={`${label} 15-minute suggestions`}>{Array.from({ length: 96 }, (_, index) => { const time = Temporal.PlainTime.from({ hour: Math.floor(index / 4), minute: index % 4 * 15 }); const text = time.toString({ smallestUnit: 'minute' }); return <button type="button" role="option" tabIndex={index === Math.floor((Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3))) / 15) ? 0 : -1} data-first-focus={index === Math.floor((Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3))) / 15) ? true : undefined} aria-selected={text === minute} onKeyDown={event => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const options = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button'); options?.[event.key === 'Home' ? 0 : event.key === 'End' ? 95 : (index + (event.key === 'ArrowUp' ? -1 : 1) + 96) % 96]?.focus(); }} key={text} onClick={() => { change(text); close(); }}>{time.toLocaleString('en-AU', { hour: 'numeric', minute: '2-digit' })}</button>; })}</div>}</FieldPopover></div>;
}

export function DateTimeField({ label, value, onChange }: { label: string; value: string; onChange: (localDateTime: string) => void }) {
  const local = Temporal.PlainDateTime.from(value);
  return <div className="centre-date-time"><span className="centre-date-time__label">{label}</span><div className="centre-date-time__controls"><DateField label={`${label} date`} value={local.toPlainDate().toString()} onChange={date => onChange(withLocalDate(value, date))} /><TimeField label={`${label} time`} value={local.toPlainTime().toString()} onChange={time => onChange(withLocalMinute(value, time))} /></div></div>;
}

export function DurationField({ label, value, onChange, min = 1, max = 10080 }: { label: string; value: number; onChange: (minutes: number) => void; min?: number; max?: number }) {
  const hours = Math.floor(value / 60), minutes = value % 60;
  function update(next: number) { if (next >= min && next <= max) onChange(next); }
  const options = Array.from({ length: 60 }, (_, value) => ({ value: String(value), label: `${value} min` }));
  return <div className="centre-duration-field"><span>{label}</span><div className="centre-duration-field__controls"><label><span className="visually-hidden">{label} hours</span><input type="number" aria-label={`${label} hours`} min="0" max={Math.floor((max - minutes) / 60)} step="1" required value={hours} onChange={event => { if (event.currentTarget.validity.valid && event.currentTarget.value !== '') update(Number(event.currentTarget.value) * 60 + minutes); }} /><span aria-hidden>h</span></label><Select label={`${label} minutes`} value={String(minutes)} options={options} onChange={value => update(hours * 60 + Number(value))} /></div><span className="visually-hidden">{formatDurationMinutes(value)}</span></div>;
}
