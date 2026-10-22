import { z } from 'zod';

export const desktopActionSchema = z.enum([
  'study-log.manual', 'study-log.timer', 'study-log.week', 'chat.new',
  'app.search', 'app.resources', 'app.calendar', 'app.settings',
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;

export const desktopActions: { id: DesktopAction; label: string; detail: string }[] = [
  { id: 'study-log.manual', label: 'Log study', detail: 'Add study time manually' },
  { id: 'study-log.timer', label: 'Study timer', detail: 'Open your timer controls' },
  { id: 'study-log.week', label: 'This week’s study', detail: 'See your current weekly hours in Log' },
  { id: 'chat.new', label: 'New chat', detail: 'Start a fresh conversation' },
  { id: 'app.search', label: 'Search Centre', detail: 'Find chats and resources' },
  { id: 'app.resources', label: 'Resources', detail: 'Open your subjects and resources' },
  { id: 'app.calendar', label: 'Calendar', detail: 'Open your calendar' },
  { id: 'app.settings', label: 'Settings', detail: 'Open Centre settings' },
];

export function desktopActionUrl(action: DesktopAction): string {
  return `centre://action/${action}`;
}

export function parseDesktopActionUrl(value: string): DesktopAction | null {
  // Exact matching also rejects URL normalization, encoded paths and extra parameters.
  return desktopActions.find(action => desktopActionUrl(action.id) === value)?.id ?? null;
}

export const desktopActionRequestSchema = z.object({
  id: z.string().uuid(),
  action: desktopActionSchema,
}).strict();
export type DesktopActionRequest = z.infer<typeof desktopActionRequestSchema>;
