import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useHrEmployee } from '@/features/hr/api';
import {
  useHrAccess,
  usePosActivity,
  useStatusHistory,
  useTransferHistory,
  useHrDocuments,
  useEnrolments,
  type HrEmploymentStatus,
} from '@/features/hr/access-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HrAccessPanel } from './HrAccessPanel';
import { HrLifecycleActions } from './HrLifecycleActions';

const fmt = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : `Rp ${Number(n).toLocaleString('id-ID')}`;

const date = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('id-ID') : '—';

const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('id-ID') : '—';

const EMP_TYPE_STYLE: Record<string, string> = {
  FULL_TIME: 'bg-emerald-100 text-emerald-800',
  PART_TIME: 'bg-sky-100 text-sky-800',
  CONTRACT: 'bg-violet-100 text-violet-800',
  INTERN: 'bg-amber-100 text-amber-800',
  CASUAL: 'bg-muted text-muted-foreground',
  PROBATION: 'bg-cyan-100 text-cyan-800',
};

export const STATUS_STYLE: Record<HrEmploymentStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-800',
  PROBATION: 'bg-cyan-100 text-cyan-800',
  ON_LEAVE: 'bg-amber-100 text-amber-800',
  SUSPENDED: 'bg-orange-100 text-orange-800',
  TERMINATED: 'bg-rose-100 text-rose-800',
  RESIGNED: 'bg-muted text-muted-foreground',
};

const ADVANCE_STATUS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-cyan-100 text-cyan-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  SETTLED: 'bg-sky-100 text-sky-800',
  REJECTED: 'bg-muted text-muted-foreground',
};

const LOAN_STATUS: Record<string, string> = {
  ACTIVE: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800',
  DEFAULTED: 'bg-rose-100 text-rose-800',
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between border-b py-2 last:border-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-right">{value ?? '—'}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/**
 * Employee 360 — one record for one person, covering who they are, what they
 * can log into, and what they have done.
 *
 * The Access tab is the centre of gravity: before the identity spine existed,
 * an administrator had to cross-reference the HR employee list against the
 * Staff screen by hand and hope the names matched.
 *
 * Compensation figures are simply absent from the API response unless the
 * caller holds `hr:compensation`, so the salary rows below render "—" rather
 * than leaking. The gate is server-side; this is only the display.
 */
export function HrEmployeeDetailPage() {
  const { id } = useParams();
  const [tab, setTab] = useState('overview');
  const { data: emp, isLoading } = useHrEmployee(id);
  const { data: access } = useHrAccess(id);
  const { data: history } = useStatusHistory(id);
  const { data: transfers } = useTransferHistory(id);
  const { data: posActivity } = usePosActivity(id);
  const { data: documents } = useHrDocuments(id ? { employeeId: id } : {});
  const { data: trainings } = useEnrolments(id ? { employeeId: id } : {});

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!emp) return <div className="p-6 text-sm text-muted-foreground">Employee not found.</div>;

  const e = emp as any;
  const fullName = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');
  const status: HrEmploymentStatus = e.employmentStatus ?? 'ACTIVE';
  const ended = status === 'TERMINATED' || status === 'RESIGNED';

  return (
    <div className="space-y-4 p-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/hr/employees" className="hover:underline">
          Employees
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground">{e.employeeCode}</span>
      </div>

      {/* Identity header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {e.photoUrl ? (
            <img src={e.photoUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold">
              {(e.firstName?.[0] ?? '?').toUpperCase()}
              {(e.lastName?.[0] ?? '').toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold">{fullName}</h1>
            <p className="text-sm text-muted-foreground">
              {e.position?.name ?? 'No position'}
              {e.department?.name ? ` · ${e.department.name}` : ''}
              {e.branch?.name ? ` · ${e.branch.name}` : ''}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge className={STATUS_STYLE[status]}>{status.replace(/_/g, ' ')}</Badge>
              <Badge className={EMP_TYPE_STYLE[e.employmentType] ?? 'bg-muted'}>
                {String(e.employmentType).replace(/_/g, ' ')}
              </Badge>
              {access?.linked ? (
                <Badge className="bg-sky-100 text-sky-800">
                  {access.user?.posAccess ? 'POS access' : 'Back office'}
                </Badge>
              ) : (
                <Badge className="bg-muted text-muted-foreground">No login</Badge>
              )}
            </div>
          </div>
        </div>

        <HrLifecycleActions employee={e} access={access} />
      </div>

      {/* A former employee stays fully readable — their history is the point. */}
      {ended && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
          <strong>Former employee.</strong> {status === 'RESIGNED' ? 'Resigned' : 'Terminated'} on{' '}
          {date(e.terminationDate)}
          {e.terminationReason ? ` — ${e.terminationReason}` : ''}. Their past orders, invoices,
          payments and cash sessions are unchanged and still resolve to them.
        </div>
      )}
      {status === 'SUSPENDED' && (
        <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm text-orange-900">
          <strong>Suspended</strong> since {date(e.suspendedAt)}
          {e.suspensionReason ? ` — ${e.suspensionReason}` : ''}. Employment continues.
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="employment">Employment</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
          <TabsTrigger value="payroll">Payroll</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="training">Training</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Personal</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <InfoRow label="Employee code" value={e.employeeCode} />
                <InfoRow label="Preferred name" value={e.preferredName} />
                <InfoRow label="Email" value={e.email} />
                <InfoRow label="Phone" value={e.phone} />
                <InfoRow label="Address" value={e.address} />
                <InfoRow label="Nationality" value={e.nationality} />
                <InfoRow label="Date of birth" value={date(e.dateOfBirth)} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Emergency contact</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <InfoRow label="Name" value={e.emergencyContactName} />
                <InfoRow label="Phone" value={e.emergencyContactPhone} />
                <InfoRow label="Relationship" value={e.emergencyContactRelation} />
              </dl>
              {!e.emergencyContactName && (
                <p className="pt-3 text-xs text-muted-foreground">
                  No emergency contact recorded.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Employment ───────────────────────────────────────────────── */}
        <TabsContent value="employment" className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Placement</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <InfoRow label="Department" value={e.department?.name} />
                <InfoRow label="Position" value={e.position?.name} />
                <InfoRow label="Branch" value={e.branch?.name} />
                <InfoRow
                  label="Supervisor"
                  value={
                    e.supervisor
                      ? `${e.supervisor.firstName}${e.supervisor.lastName ? ' ' + e.supervisor.lastName : ''}`
                      : null
                  }
                />
                <InfoRow label="Hire date" value={date(e.hireDate)} />
                <InfoRow label="Probation ends" value={date(e.probationEndDate)} />
                <InfoRow label="Confirmed" value={date(e.confirmedAt)} />
                <InfoRow label="Contract ends" value={date(e.contractEndDate)} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Compensation</CardTitle>
            </CardHeader>
            <CardContent>
              {'baseSalary' in e ? (
                <dl>
                  <InfoRow label="Base salary" value={fmt(e.baseSalary)} />
                  <InfoRow label="Pay frequency" value={String(e.payFrequency).replace(/_/g, ' ')} />
                  <InfoRow label="Hourly rate" value={fmt(e.hourlyRate)} />
                  <InfoRow label="Bank" value={e.bankName} />
                  <InfoRow label="Account number" value={e.bankAccountNumber} />
                  <InfoRow
                    label="Mobile money"
                    value={
                      e.mobileMoneyNumber
                        ? `${e.mobileMoneyProvider ?? ''} ${e.mobileMoneyNumber}`.trim()
                        : null
                    }
                  />
                  <InfoRow label="Tax number" value={e.taxNumber} />
                </dl>
              ) : (
                // The server omits these fields entirely without hr:compensation,
                // so their absence is the signal — not a null value.
                <Empty>
                  Pay, bank and tax details need the <code>hr:compensation</code> permission.
                </Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Access ───────────────────────────────────────────────────── */}
        <TabsContent value="access" className="mt-4">
          <HrAccessPanel employeeId={id!} employeeName={fullName} />
        </TabsContent>

        {/* ── Leave ────────────────────────────────────────────────────── */}
        <TabsContent value="leave" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leave balances</CardTitle>
            </CardHeader>
            <CardContent>
              {e.leaveBalances?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2">Type</th>
                      <th className="py-2 text-right">Accrued</th>
                      <th className="py-2 text-right">Adjusted</th>
                      <th className="py-2 text-right">Used</th>
                      <th className="py-2 text-right">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.leaveBalances.map((b: any) => (
                      <tr key={b.id} className="border-b last:border-0">
                        <td className="py-2">{b.leaveType?.name ?? '—'}</td>
                        <td className="py-2 text-right">{Number(b.accruedDays)}</td>
                        <td className="py-2 text-right">{Number(b.adjustedDays)}</td>
                        <td className="py-2 text-right">{Number(b.usedDays)}</td>
                        <td className="py-2 text-right font-medium">
                          {Number(b.accruedDays) + Number(b.adjustedDays) - Number(b.usedDays)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No leave balances yet.</Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Payroll ──────────────────────────────────────────────────── */}
        <TabsContent value="payroll" className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Salary advances</CardTitle>
            </CardHeader>
            <CardContent>
              {e.salaryAdvances?.length ? (
                <ul className="space-y-2">
                  {e.salaryAdvances.map((a: any) => (
                    <li key={a.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                      <span className="text-sm">{fmt(a.amount)}</span>
                      <Badge className={ADVANCE_STATUS[a.status] ?? 'bg-muted'}>{a.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No advances.</Empty>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Loans</CardTitle>
            </CardHeader>
            <CardContent>
              {e.loans?.length ? (
                <ul className="space-y-2">
                  {e.loans.map((l: any) => (
                    <li key={l.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                      <span className="text-sm">
                        {fmt(l.principal)}{' '}
                        <span className="text-muted-foreground">· balance {fmt(l.balance)}</span>
                      </span>
                      <Badge className={LOAN_STATUS[l.status] ?? 'bg-muted'}>{l.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No loans.</Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Documents ────────────────────────────────────────────────── */}
        <TabsContent value="documents" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents</CardTitle>
            </CardHeader>
            <CardContent>
              {documents?.rows?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2">Title</th>
                      <th className="py-2">Type</th>
                      <th className="py-2">Issued</th>
                      <th className="py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.rows.map((d) => {
                      const expiring =
                        d.expiresAt && new Date(d.expiresAt).getTime() - Date.now() < 60 * 86400000;
                      return (
                        <tr key={d.id} className="border-b last:border-0">
                          <td className="py-2">{d.title}</td>
                          <td className="py-2">{d.documentType.replace(/_/g, ' ')}</td>
                          <td className="py-2">{date(d.issuedAt)}</td>
                          <td className={`py-2 ${expiring ? 'font-medium text-amber-700' : ''}`}>
                            {date(d.expiresAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <Empty>
                  No documents recorded. Add them from the Documents screen (needs{' '}
                  <code>hr:document</code>).
                </Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Training ─────────────────────────────────────────────────── */}
        <TabsContent value="training" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Training</CardTitle>
            </CardHeader>
            <CardContent>
              {trainings?.rows?.length ? (
                <ul className="space-y-2">
                  {trainings.rows.map((t) => (
                    <li key={t.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                      <span className="text-sm">
                        {t.program?.name ?? '—'}
                        {t.program?.provider ? (
                          <span className="text-muted-foreground"> · {t.program.provider}</span>
                        ) : null}
                      </span>
                      <Badge className="bg-muted text-muted-foreground">{t.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Not enrolled on any training.</Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Activity ─────────────────────────────────────────────────── */}
        <TabsContent value="activity" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">POS activity (last 30 days)</CardTitle>
            </CardHeader>
            <CardContent>
              {posActivity?.linked ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    ['Sales', posActivity.sales.count],
                    ['Takings', fmt(posActivity.sales.gross)],
                    ['Served', posActivity.served.count],
                    ['Refunds', posActivity.refunds.count],
                    ['Discounts', posActivity.discountsApplied],
                    ['Cash sessions', posActivity.cashSessions.count],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-md border p-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        {label}
                      </div>
                      <div className="mt-1 text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>
                  {posActivity?.message ??
                    'No linked account, so no POS activity can be attributed.'}
                </Empty>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Employment history</CardTitle>
            </CardHeader>
            <CardContent>
              {history?.rows?.length ? (
                <ol className="space-y-3">
                  {history.rows.map((h) => (
                    <li key={h.id} className="flex gap-3 border-b pb-3 last:border-0">
                      <Badge className={STATUS_STYLE[h.toStatus]}>
                        {h.toStatus.replace(/_/g, ' ')}
                      </Badge>
                      <div className="text-sm">
                        <div>
                          {h.fromStatus ? `${h.fromStatus.replace(/_/g, ' ')} → ` : 'Recorded as '}
                          {h.toStatus.replace(/_/g, ' ')}
                          {h.accountDisabled ? ' · login disabled' : ''}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {dateTime(h.effectiveDate)}
                          {h.reason ? ` — ${h.reason}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>No status changes recorded.</Empty>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transfers</CardTitle>
            </CardHeader>
            <CardContent>
              {transfers?.rows?.length ? (
                <ol className="space-y-2">
                  {transfers.rows.map((t) => (
                    <li key={t.id} className="border-b pb-2 text-sm last:border-0">
                      <div>{t.reason ?? 'Transfer'}</div>
                      <div className="text-xs text-muted-foreground">{date(t.effectiveDate)}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>Never transferred.</Empty>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
