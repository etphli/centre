const DAY_MS = 86_400_000;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'ZodError') return 'Centre received data it could not read. Try again, and check the service log if it keeps happening.';
    return error.message || 'Something went wrong.';
  }
  if (typeof error === 'string' && error) return error;
  return 'Something went wrong.';
}

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local calendar date as YYYY-MM-DD. */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses YYYY-MM-DD (or the date part of an ISO string) as a local date. */
export function fromDateKey(key: string): Date {
  const [year, month, day] = key.slice(0, 10).split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function addDays(key: string, days: number): string {
  const date = fromDateKey(key);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function daysFromToday(key: string): number {
  return Math.round((fromDateKey(key).getTime() - fromDateKey(todayKey()).getTime()) / DAY_MS);
}

export function relativeDay(key: string): string {
  const diff = daysFromToday(key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fromDateKey(key).toLocaleDateString(undefined, { weekday: 'long' });
  if (diff < 0) return `${-diff} days ago`;
  return fromDateKey(key).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function longDay(key: string): string {
  return fromDateKey(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatTime(time: string | null): string {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date();
  date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'C';
}

export function greeting(name?: string): string {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}
