import { z } from 'zod';
import { desktopActionSchema } from './desktop-actions';

export const launcherOperationSchema = z.enum(['create', 'repair', 'remove']);
export type LauncherOperation = z.infer<typeof launcherOperationSchema>;
export const launcherStatusSchema = z.object({
  action: desktopActionSchema,
  state: z.enum(['absent', 'installed', 'missing', 'conflict']),
  filename: z.string(),
});
export type LauncherStatus = z.infer<typeof launcherStatusSchema>;
export const launcherListSchema = z.object({
  supported: z.boolean(),
  message: z.string(),
  launchers: z.array(launcherStatusSchema),
});
export type LauncherList = z.infer<typeof launcherListSchema>;
