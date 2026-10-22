import { z } from 'zod';

export const cloudStatusSchema = z.object({
  baseUrl: z.string(),
  workspaceId: z.string().nullable(),
  authenticated: z.boolean(),
  enabled: z.boolean(),
  phase: z.enum(['local', 'ready', 'pending', 'syncing', 'error', 'conflict']),
  pending: z.number().int().nonnegative(),
  conflicts: z.array(z.object({ kind: z.string(), id: z.string(), label:z.string().default('Study item'), canKeepLocal:z.boolean().default(true) })),
  lastSyncedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type CloudStatus = z.infer<typeof cloudStatusSchema>;
