import { z } from "zod";
export const CLOUD_LIMITS = {
  recordBytes: 256 * 1024,
  attachmentBytes: 20 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  workspaceAttachmentBytes: 100 * 1024 * 1024,
  records: 20000,
  receipts: 100000,
  dailyRequests: 5000,
  workspaceDailyRequests: 1000,
  dailyMutations: 1000,
  workspaceDailyMutations: 500,
};
export const cloudMutationSchema = z
  .object({
    mutationId: z.string().uuid(),
    kind: z.string().min(1).max(100),
    id: z.string().min(1).max(200),
    schemaVersion: z.literal(1),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    deleted: z.boolean(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type CloudMutation = z.infer<typeof cloudMutationSchema>;
export const cloudRecordSchema = cloudMutationSchema
  .omit({ mutationId: true, expectedVersion: true })
  .extend({
    version: z.number().int().positive(),
    cursor: z.string().regex(/^(0|[1-9]\d*)$/),
    createdCursor: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CloudRecord = z.infer<typeof cloudRecordSchema>;
export const cloudChangesSchema = z
  .object({
    records: z.array(cloudRecordSchema),
    cursor: z.string().regex(/^(0|[1-9]\d*)$/),
    hasMore: z.boolean(),
  })
  .strict();
export type CloudChanges = z.infer<typeof cloudChangesSchema>;
export const cloudAuthSchema = z
  .object({
    token: z.string(),
    deviceId: z.string().uuid(),
    workspaceId: z.string(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type CloudAuth = z.infer<typeof cloudAuthSchema>;
