import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

export const ORG_FEATURES_QUERY_KEY = ['org-features'] as const;

/**
 * The organization's module feature switches, as saved in Developer Settings.
 *
 * Read from an unprivileged endpoint so cashiers and other non-admin roles can
 * still resolve their sidebar. On failure the map stays empty, which
 * `featureEnabled` treats as "everything on" — navigation never blanks out
 * because a request failed.
 */
export function useOrgFeatures() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery<Record<string, boolean>>({
    queryKey: ORG_FEATURES_QUERY_KEY,
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () =>
      (await api.get<{ features: Record<string, boolean> }>('/settings/features')).data.features ?? {},
  });
}
