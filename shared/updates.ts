import { z } from 'zod';
export const updateStatusSchema = z.object({
  state:z.enum(['idle','checking','downloading','ready','current','available','unavailable','error']),
  message:z.string(),currentVersion:z.string().optional(),version:z.string().optional(),
  downloaded:z.boolean().optional(),downloadUrl:z.string().url().optional(),releaseUrl:z.string().url().optional(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
