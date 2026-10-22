import { Temporal } from '@js-temporal/polyfill';

/** Replace only the date. Hidden seconds remain intact. */
export function withLocalDate(value: string, date: string): string {
  const next = Temporal.PlainDate.from(date);
  return Temporal.PlainDateTime.from(value).with({ year: next.year, month: next.month, day: next.day }).toString();
}

/** A minute unchanged by the user must not discard measured seconds. */
export function withLocalMinute(value: string, minute: string): string {
  const current = Temporal.PlainDateTime.from(value);
  const next = Temporal.PlainTime.from(minute);
  if (current.hour === next.hour && current.minute === next.minute) return value;
  return current.with({ hour: next.hour, minute: next.minute, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }).toString();
}

export function formatDurationMinutes(minutes: number): string {
  const whole = Math.floor(minutes);
  if (minutes > 0 && whole === 0) return '<1 min';
  return whole >= 60 ? `${Math.floor(whole / 60)} h${whole % 60 ? ` ${whole % 60} min` : ''}` : `${whole} min`;
}
