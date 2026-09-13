import type { AxiosRequestConfig } from 'axios';
import { api } from '@/lib/api';

/**
 * Money-moving requests carry an Idempotency-Key that stays the SAME until the
 * server gives a definitive answer. A timeout, dropped connection, 5xx or a
 * double-click retries with the original key, so the server replays the first
 * result instead of posting the money twice. The key is released only on
 * success or on a definitive client error (4xx), after which a corrected
 * submission is genuinely a new operation.
 *
 * Keys are keyed by (method, url, payload) and kept in sessionStorage so a page
 * reload during an outage still reuses them.
 */
const PREFIX = 'idem:';

function fingerprint(method: string, url: string, body: unknown): string {
  const text = `${method} ${url} ${JSON.stringify(body ?? {})}`;
  // FNV-1a 32-bit ×2 (different seeds) — compact, stable, collision-safe enough for a per-tab cache key.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${PREFIX}${a.toString(16)}${b.toString(16)}`;
}

function store(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function newKey(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}

export function operationKeyFor(method: string, url: string, body: unknown): { key: string; release: () => void } {
  const slot = fingerprint(method, url, body);
  const s = store();
  let key: string | null = null;
  try { key = s?.getItem(slot) ?? null; } catch { key = null; }
  if (!key) {
    key = newKey();
    try { s?.setItem(slot, key); } catch { /* storage unavailable: key lives for this call only */ }
  }
  return { key, release: () => { try { s?.removeItem(slot); } catch { /* ignore */ } } };
}

function isDefinitive(error: any): boolean {
  const status = error?.response?.status;
  // 409 OPERATION_PENDING means "still processing" — keep the key and retry later.
  if (status === 409 && error?.response?.data?.code === 'OPERATION_PENDING') return false;
  return typeof status === 'number' && status >= 400 && status < 500;
}

async function send<T>(method: 'post' | 'patch', url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const { key, release } = operationKeyFor(method, url, body);
  try {
    const res = await api.request<T>({ ...config, method, url, data: body, headers: { ...(config?.headers ?? {}), 'Idempotency-Key': key } });
    release();
    return res.data;
  } catch (error) {
    if (isDefinitive(error)) release();
    throw error;
  }
}

export const idempotentPost = <T = any>(url: string, body?: unknown, config?: AxiosRequestConfig) => send<T>('post', url, body, config);
export const idempotentPatch = <T = any>(url: string, body?: unknown, config?: AxiosRequestConfig) => send<T>('patch', url, body, config);
