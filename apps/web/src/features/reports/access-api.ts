import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REPORT_CATALOG, type ReportDescriptor } from '@erp/shared';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';

export interface RoleReportVisibility {
  id: string;
  name: string;
  isSystem?: boolean;
  /** Reports the role sees today. */
  reports: string[];
  /** false = inheriting the permission default. */
  configured: boolean;
  /** Reports the role's permissions allow at all. */
  available: string[];
}

/** Catalog from the API, falling back to the bundled copy while it loads. */
export function useReportCatalog() {
  return useQuery({
    queryKey: ['reports', 'access', 'catalog'],
    queryFn: async () =>
      (await api.get<{ reports: ReportDescriptor[] }>('/reports/access/catalog')).data.reports,
    initialData: REPORT_CATALOG as ReportDescriptor[],
    staleTime: 5 * 60_000,
  });
}

export function useRoleReportVisibility() {
  return useQuery({
    queryKey: ['reports', 'access', 'roles'],
    queryFn: async () =>
      (await api.get<{ roles: RoleReportVisibility[] }>('/reports/access/roles')).data.roles,
  });
}

export function useSetRoleReportVisibility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roleId, reports }: { roleId: string; reports: string[] | null }) =>
      (await api.put<RoleReportVisibility>(`/reports/access/roles/${roleId}`, { reports })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports', 'access'] });
      notify.success('Report visibility saved');
    },
    onError: (e: any) =>
      notify.error('Failed to save report visibility', e?.response?.data?.message ?? e.message),
  });
}

/**
 * Report ids the signed-in user may see. Cached for the session; the API is the
 * authority on the underlying data either way, so a stale copy only affects
 * which tabs are offered.
 */
export function useMyReportAccess() {
  const token = useAuthStore((s) => s.accessToken);
  return useQuery({
    queryKey: ['reports', 'access', 'me'],
    enabled: Boolean(token),
    queryFn: async () => (await api.get<{ reports: string[] }>('/reports/access/me')).data.reports,
    staleTime: 60_000,
  });
}

/**
 * `can(reportId)` for the current user. While the config is loading it answers
 * from permissions alone, so nothing flickers away from someone entitled to it.
 */
export function useCanViewReport() {
  const { data, isSuccess } = useMyReportAccess();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const allowed = useMemo(() => new Set(data ?? []), [data]);
  return useMemo(
    () => (reportId: string) => {
      if (!isSuccess) {
        const report = REPORT_CATALOG.find((r) => r.id === reportId);
        return report ? hasPermission(report.permission) : true;
      }
      return allowed.has(reportId);
    },
    [allowed, isSuccess, hasPermission],
  );
}
