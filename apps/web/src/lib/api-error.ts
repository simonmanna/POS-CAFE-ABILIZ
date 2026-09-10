/**
 * Pull a human-readable message out of an axios error.
 *
 * Nest's ValidationPipe returns `message` as a string[] — one entry per failed
 * constraint — so rendering it straight into a toast prints "[object Object]"
 * or a bare comma-blob, and a validation failure looks like an opaque server
 * error on screen. Every HR mutation surfaces real, actionable 400s (overlapping
 * leave, a duplicate link, a missing termination reason), so those messages are
 * worth showing properly.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(message)) return message.filter(Boolean).map(String).join('; ') || fallback;
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}
