import { toast } from 'sonner';

export const notify = {
  success: (message: string, description?: string) => toast.success(message, { description }),
  error: (message: string, description?: string) => toast.error(message, { description }),
  info: (message: string, description?: string) => toast.info(message, { description }),
  warning: (message: string, description?: string) => toast.warning(message, { description }),
  loading: (message: string) => toast.loading(message),
  promise: <T,>(promise: Promise<T>, messages: { loading: string; success: string; error: string }) =>
    toast.promise(promise, messages),
  dismiss: (id?: string | number) => toast.dismiss(id),
};

/**
 * Pull a human-readable message out of an axios error.
 *
 * Nest's ValidationPipe returns `message` as a string[] (one entry per failed
 * constraint); rendering that straight into a toast printed "[object Object]"
 * or a bare comma-blob, which is why validation failures looked like opaque
 * server errors on screen.
 */
export function apiMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(message)) return message.filter(Boolean).map(String).join('; ') || fallback;
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
}
