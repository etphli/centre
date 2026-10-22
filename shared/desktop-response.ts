import { z } from 'zod';

const desktopResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

export type DesktopResponse = z.infer<typeof desktopResponseSchema>;

export function unwrapDesktopResponse(value: unknown): unknown {
  const result = desktopResponseSchema.parse(value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
