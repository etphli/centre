export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export function requireFound<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new HttpError(404, `${label} not found`);
  return value;
}
