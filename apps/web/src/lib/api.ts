import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { getPosToken, posSessionRevoked } from '@/features/pos/pos-session';
import { notify } from '@/lib/notify';

function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_URL;
  if (!raw) return '/api/v1';
  return `${raw.replace(/\/$/, '')}/api/v1`;
}

const baseURL = getApiBaseUrl();
export { getApiBaseUrl };

/**
 * Absolutize a server-provided asset path (e.g. a signed file download URL) so
 * it loads from the API origin, not the web dev-server origin.
 *
 * The API mints image URLs as relative paths like `/api/v1/files/:id/download`.
 * When VITE_API_URL points at a different origin (dev: API on :3000, web on
 * :5173) and there is no proxy, an <img src="/api/v1/..."> would hit :5173 and
 * 404. Prefix the API origin in that case. Already-absolute (http) URLs and the
 * proxy case (no VITE_API_URL) pass through unchanged.
 */
export function resolveAssetUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  const origin = raw ? raw.replace(/\/$/, '') : '';
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

export const api = axios.create({
  baseURL,
  withCredentials: false,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

/* ── Server reachability ─────────────────────────────────────────────────────
 * A response with no HTTP status never reached the API: the network is down, the
 * service is stopped, or the request timed out. The POS needs to know that
 * WITHOUT probing, so it can stop walking into a full timeout on every keystroke
 * and keep selling against the local cart instead.
 *
 * Deliberately NOT `navigator.onLine`: the common install runs the API and the
 * database on the till itself, where an unplugged cable reads as "offline" while
 * the server is perfectly reachable. Only a request that actually failed counts,
 * and any answered request — including a 4xx — clears it.
 */
let lastNetworkFailureAt: number | null = null;
export function noteServerUnreachable(): void { lastNetworkFailureAt = Date.now(); }
export function noteServerReachable(): void { lastNetworkFailureAt = null; }
/** True when a request failed to reach the server within the last `withinMs`. */
export function serverUnreachable(withinMs = 15_000): boolean {
  return lastNetworkFailureAt != null && Date.now() - lastNetworkFailureAt < withinMs;
}

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Attribute POS requests to the cashier who PINned in (the backend overrides
  // the request identity from this token; the bearer JWT still bounds the org).
  const posToken = getPosToken();
  if (posToken) {
    config.headers = config.headers ?? {};
    config.headers['X-Pos-User'] = posToken;
  }
  // Money-touching routes require an Idempotency-Key (retry can never charge
  // twice). Callers that manage their own stable key — checkout, settle and
  // the offline replay queue — set it first; everything else gets a fresh
  // per-attempt key. crypto.randomUUID only exists in secure contexts, so
  // fall back for LAN-over-http terminals.
  const method = (config.method || '').toLowerCase();
  if (['post', 'put', 'patch', 'delete'].includes(method)) {
    config.headers = config.headers ?? {};
    if (!config.headers['Idempotency-Key']) {
      const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
      config.headers['Idempotency-Key'] = uuid;
    }
  }
  return config;
});

// ---- Automatic refresh on 401 (single-flight) ----
let refreshing: Promise<string | null> | null = null;

async function refresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;
  try {
    const res = await axios.post<{ accessToken: string; refreshToken: string }>(
      `${baseURL}/auth/refresh`,
      { refreshToken },
    );
    useAuthStore.getState().setTokens(res.data.accessToken, res.data.refreshToken);
    return res.data.accessToken;
  } catch {
    useAuthStore.getState().clear();
    return null;
  }
}

api.interceptors.response.use(
  (r) => { noteServerReachable(); return r; },
  async (err: AxiosError) => {
    const status = err.response?.status;
    // The server answered — whatever it said, it is up.
    if (status) noteServerReachable();
    const original = err.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    // The cashier's POS token was revoked (disabled, deleted, or taken off the
    // tills by HR). The back-office session is fine, so do NOT refresh or sign
    // the terminal out: drop the cashier and return to the PIN screen.
    if (status === 401 && err.response?.headers?.['x-pos-session'] === 'revoked') {
      posSessionRevoked();
      notify.error((err.response?.data as any)?.message || 'This cashier can no longer use the POS.');
      throw err;
    }
    if (status === 401 && original && !original._retry && !original.url?.includes('/auth/')) {
      original._retry = true;
      refreshing = refreshing ?? refresh();
      const newToken = await refreshing;
      refreshing = null;
      if (newToken) {
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        return api.request(original);
      }
    }
    // Surface the server's actionable message rather than generic Axios text.
    // The API returns { message: string | string[] } on 4xx; expose it as
    // `err.userMessage` so call sites and toasts can show the real reason.
    const body: any = err.response?.data;
    const serverMsg = Array.isArray(body?.message) ? body.message.join('; ') : (typeof body?.message === 'string' ? body.message : undefined);
    (err as any).userMessage = serverMsg;
    if (status === 403) notify.error(serverMsg || 'Permission denied');
    if (status && status >= 500) notify.error(serverMsg || 'Server error — please retry');
    // A cancelled request (a component unmounted, a query superseded) says
    // nothing about the server, so it must not be read as an outage.
    if (!status && !axios.isCancel(err) && err.code !== 'ERR_CANCELED') {
      // One notice per outage, not one per request: an offline terminal saves,
      // quotes and polls constantly, and it used to toast on every one of them.
      const alreadyKnown = serverUnreachable();
      noteServerUnreachable();
      if (!alreadyKnown) notify.error('No connection to the server — work is kept on this device');
    }
    throw err;
  },
);
