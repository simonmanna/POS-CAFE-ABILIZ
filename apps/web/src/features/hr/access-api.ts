/**
 * Identity spine, lifecycle, self-service, documents, training and POS
 * analytics.
 *
 * Kept beside `api.ts` rather than inside it: that file already covers the
 * original HR vertical and is long enough that appending six more subsystems
 * would make both harder to navigate. Same conventions — react-query hooks over
 * the shared axios instance, paths relative to `/api/v1`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HrLinkedRole {
  id: string;
  name: string;
}

export interface HrLinkedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  defaultBranchId: string | null;
  lockedUntil: string | null;
  roles: HrLinkedRole[];
  /** Whether the account carries any `pos:*` permission. */
  posAccess: boolean;
  /** Boolean only — the PIN hash never leaves the server. */
  hasPin: boolean;
}

export interface HrAccess {
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string | null;
    isActive: boolean;
  };
  linked: boolean;
  user: HrLinkedUser | null;
}

export interface HrLinkableUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  roles: HrLinkedRole[];
}

export type HrEmploymentStatus =
  | 'ACTIVE'
  | 'PROBATION'
  | 'ON_LEAVE'
  | 'SUSPENDED'
  | 'TERMINATED'
  | 'RESIGNED';

export interface HrStatusHistoryRow {
  id: string;
  fromStatus: HrEmploymentStatus | null;
  toStatus: HrEmploymentStatus;
  effectiveDate: string;
  reason: string | null;
  accountDisabled: boolean;
  actorUserId: string | null;
  createdAt: string;
}

export interface HrTransferRow {
  id: string;
  fromBranchId: string | null;
  toBranchId: string | null;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  fromPositionId: string | null;
  toPositionId: string | null;
  effectiveDate: string;
  reason: string | null;
  createdAt: string;
}

export interface HrPosActivity {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string | null };
  linked: boolean;
  range: { from: string; to: string } | null;
  sales: { count: number; gross: number };
  served: { count: number };
  refunds: { count: number; amount: number };
  cashSessions: { count: number; open: number };
  discountsApplied: number;
  message?: string;
}

export interface HrDocument {
  id: string;
  employeeId: string;
  documentType: string;
  title: string;
  fileId: string | null;
  documentNumber: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  employee?: { id: string; employeeCode: string; firstName: string; lastName: string | null };
}

export interface HrTrainingProgram {
  id: string;
  code: string;
  name: string;
  description: string | null;
  provider: string | null;
  durationHours: number | null;
  isActive: boolean;
  _count?: { enrolments: number };
}

export interface HrEnrolment {
  id: string;
  employeeId: string;
  programId: string;
  status: string;
  enrolledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
  trainer: string | null;
  notes: string | null;
  employee?: { id: string; employeeCode: string; firstName: string; lastName: string | null };
  program?: { id: string; code: string; name: string; provider: string | null };
}

export interface HrTeamMemberToday {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string | null;
  employmentStatus: HrEmploymentStatus;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  lateMinutes: number;
}

// ── Identity spine ─────────────────────────────────────────────────────────

export function useHrAccess(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['hr-access', employeeId],
    queryFn: async () => (await api.get<HrAccess>(`/hr/employees/${employeeId}/access`)).data,
    enabled: !!employeeId,
  });
}

export function useHrLinkableUsers(search?: string) {
  return useQuery({
    queryKey: ['hr-linkable-users', search],
    queryFn: async () =>
      (await api.get<{ rows: HrLinkableUser[]; total: number }>('/hr/access/linkable-users', {
        params: { search, take: 100 },
      })).data,
  });
}

/**
 * Invalidate everything a link or lifecycle change can affect.
 *
 * `api.ts` keys its queries under the `['hr', ...]` prefix while this file uses
 * flat `'hr-*'` keys, and react-query matches prefixes element by element — so
 * `['hr']` does NOT match `['hr-access']`. Both families have to be named
 * explicitly or the 360 silently keeps showing pre-change data.
 */
function useHrInvalidate() {
  const qc = useQueryClient();
  return (employeeId?: string) => {
    // Everything in api.ts: employees, dashboard, departments, reports.
    qc.invalidateQueries({ queryKey: ['hr'] });
    // This file's own keys.
    qc.invalidateQueries({ queryKey: ['hr-access', employeeId] });
    qc.invalidateQueries({ queryKey: ['hr-linkable-users'] });
    qc.invalidateQueries({ queryKey: ['hr-status-history', employeeId] });
    qc.invalidateQueries({ queryKey: ['hr-transfers', employeeId] });
    qc.invalidateQueries({ queryKey: ['hr-pos-activity', employeeId] });
    qc.invalidateQueries({ queryKey: ['hr-workforce-access'] });
    // The Staff screen shows the same accounts.
    qc.invalidateQueries({ queryKey: ['staff'] });
  };
}

export function useLinkUser() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({ employeeId, userId }: { employeeId: string; userId: string }) =>
      (await api.post<HrAccess>(`/hr/employees/${employeeId}/link-user`, { userId })).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useUnlinkUser() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (employeeId: string) =>
      (await api.delete<HrAccess>(`/hr/employees/${employeeId}/link-user`)).data,
    onSuccess: (_d, employeeId) => invalidate(employeeId),
  });
}

export function useProvisionUser() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      email: string;
      password: string;
      firstName: string;
      lastName?: string;
      roleIds: string[];
      isActive?: boolean;
    }) => (await api.post<HrAccess>(`/hr/employees/${employeeId}/provision-user`, body)).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useUpdateAccess() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      roleIds?: string[];
      isActive?: boolean;
    }) => (await api.patch<HrAccess>(`/hr/employees/${employeeId}/access`, body)).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

/** Set or reset the linked account's POS PIN (manager action). */
export function useSetEmployeePin() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({ employeeId, pin }: { employeeId: string; pin: string }) =>
      (await api.post<HrAccess>(`/hr/employees/${employeeId}/access/pin`, { pin })).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

/** Remove the linked account's POS PIN. */
export function useClearEmployeePin() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async (employeeId: string) =>
      (await api.delete<HrAccess>(`/hr/employees/${employeeId}/access/pin`)).data,
    onSuccess: (_d, employeeId) => invalidate(employeeId),
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export function useStatusHistory(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['hr-status-history', employeeId],
    queryFn: async () =>
      (await api.get<{ rows: HrStatusHistoryRow[] }>(`/hr/employees/${employeeId}/status-history`))
        .data,
    enabled: !!employeeId,
  });
}

export function useTransferHistory(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['hr-transfers', employeeId],
    queryFn: async () =>
      (await api.get<{ rows: HrTransferRow[] }>(`/hr/employees/${employeeId}/transfers`)).data,
    enabled: !!employeeId,
  });
}

export function useTerminateEmployee() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      reason: string;
      disableAccount: boolean;
      terminationDate?: string;
      resigned?: boolean;
    }) => (await api.post(`/hr/employees/${employeeId}/terminate`, body)).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useSuspendEmployee() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      reason: string;
      disableAccount: boolean;
    }) => (await api.post(`/hr/employees/${employeeId}/suspend`, body)).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useReactivateEmployee() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      reason?: string;
      enableAccount?: boolean;
      toProbation?: boolean;
    }) => (await api.post(`/hr/employees/${employeeId}/reactivate`, body)).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useConfirmEmployee() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({ employeeId, reason }: { employeeId: string; reason?: string }) =>
      (await api.post(`/hr/employees/${employeeId}/confirm`, { reason })).data,
    onSuccess: (_d, v) => invalidate(v.employeeId),
  });
}

export function useTransferEmployee() {
  const invalidate = useHrInvalidate();
  return useMutation({
    mutationFn: async ({
      employeeId,
      ...body
    }: {
      employeeId: string;
      toBranchId?: string;
      toDepartmentId?: string;
      toPositionId?: string;
      effectiveDate?: string;
      reason: string;
    }) => (await api.post(`/hr/employees/${employeeId}/transfer`, body)).data,
    onSuccess: (_d, v) => {
      invalidate(v.employeeId);
    },
  });
}

// ── POS x HR analytics ─────────────────────────────────────────────────────

export function usePosActivity(employeeId: string | undefined, range?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['hr-pos-activity', employeeId, range],
    queryFn: async () =>
      (await api.get<HrPosActivity>(`/hr/employees/${employeeId}/pos-activity`, { params: range }))
        .data,
    enabled: !!employeeId,
  });
}

export function useWorkforceSales(range?: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['hr-workforce-sales', range],
    queryFn: async () =>
      (await api.get<{
        rows: {
          employeeId: string;
          employeeCode: string;
          firstName: string;
          lastName: string | null;
          salesCount: number;
          salesGross: number;
        }[];
      }>('/hr/reports/workforce-sales', { params: range })).data,
  });
}

export function useWorkforceAccess() {
  return useQuery({
    queryKey: ['hr-workforce-access'],
    queryFn: async () =>
      (await api.get<{
        total: number;
        linked: number;
        unlinked: number;
        accountsActive: number;
        byStatus: { status: HrEmploymentStatus; count: number }[];
      }>('/hr/reports/workforce-access')).data,
  });
}

// ── Documents ──────────────────────────────────────────────────────────────

export function useHrDocuments(params: { employeeId?: string; documentType?: string } = {}) {
  return useQuery({
    queryKey: ['hr-documents', params],
    queryFn: async () =>
      (await api.get<{ rows: HrDocument[]; total: number }>('/hr/documents', { params })).data,
  });
}

export function useExpiringDocuments(days = 60) {
  return useQuery({
    queryKey: ['hr-documents-expiring', days],
    queryFn: async () =>
      (await api.get<{ rows: HrDocument[]; total: number }>('/hr/documents/expiring', {
        params: { days },
      })).data,
  });
}

function useDocInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['hr-documents'] });
    qc.invalidateQueries({ queryKey: ['hr-documents-expiring'] });
  };
}

export function useCreateDocument() {
  const invalidate = useDocInvalidate();
  return useMutation({
    mutationFn: async (body: Partial<HrDocument> & { employeeId: string; title: string }) =>
      (await api.post<HrDocument>('/hr/documents', body)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateDocument() {
  const invalidate = useDocInvalidate();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Partial<HrDocument>) =>
      (await api.patch<HrDocument>(`/hr/documents/${id}`, body)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteDocument() {
  const invalidate = useDocInvalidate();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/hr/documents/${id}`)).data,
    onSuccess: invalidate,
  });
}

// ── Training ───────────────────────────────────────────────────────────────

export function useTrainingPrograms(search?: string) {
  return useQuery({
    queryKey: ['hr-training-programs', search],
    queryFn: async () =>
      (await api.get<{ rows: HrTrainingProgram[]; total: number }>('/hr/training/programs', {
        params: { search },
      })).data,
  });
}

function useTrainingInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['hr-training-programs'] });
    qc.invalidateQueries({ queryKey: ['hr-enrolments'] });
  };
}

export function useCreateProgram() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async (body: Partial<HrTrainingProgram> & { code: string; name: string }) =>
      (await api.post<HrTrainingProgram>('/hr/training/programs', body)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateProgram() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Partial<HrTrainingProgram>) =>
      (await api.patch<HrTrainingProgram>(`/hr/training/programs/${id}`, body)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteProgram() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/hr/training/programs/${id}`)).data,
    onSuccess: invalidate,
  });
}

export function useEnrolments(params: { employeeId?: string; programId?: string; status?: string } = {}) {
  return useQuery({
    queryKey: ['hr-enrolments', params],
    queryFn: async () =>
      (await api.get<{ rows: HrEnrolment[]; total: number }>('/hr/training/enrolments', { params }))
        .data,
  });
}

export function useEnrol() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async (body: { employeeId: string; programId: string; trainer?: string; notes?: string }) =>
      (await api.post<HrEnrolment>('/hr/training/enrolments', body)).data,
    onSuccess: invalidate,
  });
}

export function useUpdateEnrolment() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Partial<HrEnrolment>) =>
      (await api.patch<HrEnrolment>(`/hr/training/enrolments/${id}`, body)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteEnrolment() {
  const invalidate = useTrainingInvalidate();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/hr/training/enrolments/${id}`)).data,
    onSuccess: invalidate,
  });
}

// ── Self-service ───────────────────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: ['hr-me'],
    queryFn: async () =>
      (await api.get<{ linked: boolean; employee: any; message?: string }>('/hr/me')).data,
  });
}

export function useMyAttendance(params: Record<string, unknown> = {}) {
  return useQuery({
    queryKey: ['hr-me-attendance', params],
    queryFn: async () => (await api.get<{ rows: any[] }>('/hr/me/attendance', { params })).data,
  });
}

export function useMyLeave() {
  return useQuery({
    queryKey: ['hr-me-leave'],
    queryFn: async () => (await api.get<{ rows: any[] }>('/hr/me/leave')).data,
  });
}

export function useMyLeaveBalances() {
  return useQuery({
    queryKey: ['hr-me-leave-balances'],
    queryFn: async () => (await api.get<{ rows: any[] }>('/hr/me/leave/balances')).data,
  });
}

export function useMyPayslips() {
  return useQuery({
    queryKey: ['hr-me-payslips'],
    queryFn: async () => (await api.get<{ rows: any[] }>('/hr/me/payslips')).data,
  });
}

export function useMyTrainings() {
  return useQuery({
    queryKey: ['hr-me-trainings'],
    queryFn: async () => (await api.get<{ rows: HrEnrolment[] }>('/hr/me/trainings')).data,
  });
}

export function useClockSelf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { eventType: string; note?: string }) =>
      (await api.post('/hr/me/clock', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-me-attendance'] });
      qc.invalidateQueries({ queryKey: ['hr-team-today'] });
    },
  });
}

export function useRequestOwnLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      leaveTypeId: string;
      startDate: string;
      endDate: string;
      reason?: string;
    }) => (await api.post('/hr/me/leave', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-me-leave'] });
      qc.invalidateQueries({ queryKey: ['hr-me-leave-balances'] });
    },
  });
}

export function useCancelOwnLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/hr/me/leave/${id}/cancel`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-me-leave'] });
      qc.invalidateQueries({ queryKey: ['hr-me-leave-balances'] });
    },
  });
}

// ── Manager / team ─────────────────────────────────────────────────────────

export function useTeam() {
  return useQuery({
    queryKey: ['hr-team'],
    queryFn: async () => (await api.get<{ rows: any[]; total: number }>('/hr/team')).data,
  });
}

export function useTeamToday() {
  return useQuery({
    queryKey: ['hr-team-today'],
    queryFn: async () =>
      (await api.get<{
        total: number;
        present: number;
        late: number;
        onLeave: number;
        absent: number;
        notClockedIn: number;
        rows: HrTeamMemberToday[];
      }>('/hr/team/today')).data,
  });
}

export function useTeamLeave(status?: string) {
  return useQuery({
    queryKey: ['hr-team-leave', status],
    queryFn: async () =>
      (await api.get<{ rows: any[]; total: number }>('/hr/team/leave', { params: { status } })).data,
  });
}

export function useTeamLeaveDecision(action: 'approve' | 'reject') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) =>
      (await api.post(`/hr/team/leave/${id}/${action}`, { reason })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-team-leave'] });
      qc.invalidateQueries({ queryKey: ['hr-team-today'] });
    },
  });
}
