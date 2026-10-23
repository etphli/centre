import { z } from 'zod';

export const nativeSaveResultSchema = z.discriminatedUnion('saved', [
  z.object({ saved: z.literal(false) }).strict(),
  z.object({ saved: z.literal(true), filename: z.string().min(1) }).strict(),
]);

export type NativeSaveResult = z.infer<typeof nativeSaveResultSchema>;
