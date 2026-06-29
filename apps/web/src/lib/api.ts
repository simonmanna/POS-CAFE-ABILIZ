import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { getPosToken } from '@/features/pos/pos-session';
import { notify } from '@/lib/notify';

const baseURL = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api/v1`
  : '/api/v1';

export const api = axios.create({
  baseURL,
  withCredentials: false,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

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
  (r) => r,
  async (err: AxiosError) => {
    const status = err.response?.status;
    const original = err.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
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
    if (status === 403) notify.error('Permission denied');
    if (status && status >= 500) notify.error('Server error — please retry');
    if (!status) notify.error('Network error — please check your connection');
    throw err;
  },
);
