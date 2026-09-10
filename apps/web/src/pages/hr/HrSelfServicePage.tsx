import { useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import {
  useCancelOwnLeave,
  useClockSelf,
  useMe,
  useMyAttendance,
  useMyLeave,
  useMyLeaveBalances,
  useMyPayslips,
  useMyTrainings,
  useRequestOwnLeave,
} from '@/features/hr/access-api';
import { useHrLeaveTypes } from '@/features/hr/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { notify } from '@/lib/notify';
import { apiErrorMessage } from '@/lib/api-error';

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('id-ID') : '—');
const time = (d: string | null) =>
  d ? new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '—';
const money = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : `Rp ${Number(n).toLocaleString('id-ID')}`;

const LEAVE_STATUS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-muted text-muted-foreground',
};

/**
 * Employee self-service.
 *
 * Everything on this page is the signed-in person's own record, resolved
 * server-side from their session through the Employee <-> User link. Someone
 * whose login has never been linked sees an explanation rather than an error,
 * because that is a normal state, not a fault.
 */
export function HrSelfServicePage() {
  const [tab, setTab] = useState('overview');
  const { data: me, isLoading } = useMe();

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  if (!me?.linked) {
    return (
      <div className="p-6">
        <Card className="mx-auto max-w-lg">
          <CardHeader>
            <CardTitle className="text-base">Self-service is not set up for you</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              {me?.message ??
                'Your login is not linked to an employee record, so there is nothing to show here yet.'}
            </p>
            <p>
              Ask HR to link your account from the employee&apos;s Access tab. Nothing about how you
              sign in or what you can do changes when they do — linking only tells the system which
              employee you are.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const e = me.employee;
  const fullName = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' ');

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{fullName}</h1>
          <p className="text-sm text-muted-foreground">
            {e.position?.name ?? 'No position'}
            {e.department?.name ? ` · ${e.department.name}` : ''}
            {e.branch?.name ? ` · ${e.branch.name}` : ''} · {e.employeeCode}
          </p>
        </div>
        <ClockButtons />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="leave">Leave</TabsTrigger>
          <TabsTrigger value="payslips">Payslips</TabsTrigger>
          <TabsTrigger value="training">Training</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My employment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Status" value={String(e.employmentStatus).replace(/_/g, ' ')} />
              <Row label="Type" value={String(e.employmentType).replace(/_/g, ' ')} />
              <Row label="Hire date" value={date(e.hireDate)} />
              <Row
                label="Supervisor"
                value={
                  e.supervisor
                    ? `${e.supervisor.firstName} ${e.supervisor.lastName ?? ''}`.trim()
                    : '—'
                }
              />
              <Row label="Base salary" value={money(e.baseSalary)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Leave balances</CardTitle>
            </CardHeader>
            <CardContent>
              <LeaveBalances />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attendance" className="mt-4">
          <MyAttendance />
        </TabsContent>

        <TabsContent value="leave" className="mt-4">
          <MyLeave />
        </TabsContent>

        <TabsContent value="payslips" className="mt-4">
          <MyPayslips />
        </TabsContent>

        <TabsContent value="training" className="mt-4">
          <MyTraining />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b py-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ClockButtons() {
  const clock = useClockSelf();
  const run = async (eventType: 'CHECK_IN' | 'CHECK_OUT') => {
    try {
      await clock.mutateAsync({ eventType });
      notify.success(eventType === 'CHECK_IN' ? 'Clocked in' : 'Clocked out');
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not record that clock event'));
    }
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={clock.isPending} onClick={() => run('CHECK_IN')}>
        <LogIn className="mr-1.5 h-3.5 w-3.5" />
        Clock in
      </Button>
      <Button size="sm" variant="outline" disabled={clock.isPending} onClick={() => run('CHECK_OUT')}>
        <LogOut className="mr-1.5 h-3.5 w-3.5" />
        Clock out
      </Button>
    </div>
  );
}

function LeaveBalances() {
  const { data } = useMyLeaveBalances();
  if (!data?.rows?.length)
    return <p className="py-4 text-sm text-muted-foreground">No leave balances yet.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {data.rows.map((b: any) => (
        <li key={b.id} className="flex items-center justify-between border-b py-1.5 last:border-0">
          <span>{b.leaveType?.name ?? '—'}</span>
          <span className="font-medium">
            {Number(b.accruedDays) + Number(b.adjustedDays) - Number(b.usedDays)} left
          </span>
        </li>
      ))}
    </ul>
  );
}

function MyAttendance() {
  const { data } = useMyAttendance({ take: 30 });
  return (
    <Card>
      <CardContent className="pt-6">
        {data?.rows?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2">Date</th>
                <th className="py-2">Status</th>
                <th className="py-2">In</th>
                <th className="py-2">Out</th>
                <th className="py-2 text-right">Worked (min)</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((a: any) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-2">{date(a.date)}</td>
                  <td className="py-2">{String(a.status).replace(/_/g, ' ')}</td>
                  <td className="py-2">{time(a.checkInAt)}</td>
                  <td className="py-2">{time(a.checkOutAt)}</td>
                  <td className="py-2 text-right">{a.workedMinutes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No attendance recorded.</p>
        )}
      </CardContent>
    </Card>
  );
}

function MyLeave() {
  const { data } = useMyLeave();
  const { data: types } = useHrLeaveTypes();
  const request = useRequestOwnLeave();
  const cancel = useCancelOwnLeave();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">My leave</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}>
          Request leave
        </Button>
      </CardHeader>
      <CardContent>
        {data?.rows?.length ? (
          <ul className="divide-y">
            {data.rows.map((r: any) => (
              <li key={r.id} className="flex items-center justify-between py-2.5">
                <div className="text-sm">
                  <div>
                    {r.leaveType?.name}{' '}
                    <span className="text-muted-foreground">
                      {date(r.startDate)} → {date(r.endDate)} · {Number(r.days)}d
                    </span>
                  </div>
                  {r.reason && <div className="text-xs text-muted-foreground">{r.reason}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={LEAVE_STATUS[r.status] ?? 'bg-muted'}>{r.status}</Badge>
                  {(r.status === 'PENDING' || r.status === 'APPROVED') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={async () => {
                        try {
                          await cancel.mutateAsync(r.id);
                          notify.success('Leave cancelled');
                        } catch (err) {
                          notify.error(apiErrorMessage(err, 'Could not cancel that request'));
                        }
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No leave requests yet.</p>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request leave</DialogTitle>
            <DialogDescription>
              Goes to your manager for approval. Overlapping an existing request is rejected, and
              you cannot approve your own.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Leave type</Label>
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={form.leaveTypeId}
                onChange={(e) => set('leaveTypeId', e.target.value)}
              >
                <option value="">Select…</option>
                {(types?.rows ?? []).map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>From</Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => set('startDate', e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>To</Label>
                <Input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => set('endDate', e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Reason</Label>
              <Textarea
                value={form.reason}
                onChange={(e) => set('reason', e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                request.isPending || !form.leaveTypeId || !form.startDate || !form.endDate
              }
              onClick={async () => {
                try {
                  await request.mutateAsync(form);
                  notify.success('Leave requested');
                  setOpen(false);
                  setForm({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
                } catch (err) {
                  notify.error(apiErrorMessage(err, 'Could not submit the request'));
                }
              }}
            >
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function MyPayslips() {
  const { data } = useMyPayslips();
  return (
    <Card>
      <CardContent className="pt-6">
        {data?.rows?.length ? (
          <ul className="divide-y">
            {data.rows.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <div>{p.payslipNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.item?.run?.runNumber ?? '—'} · issued {date(p.issuedAt)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">{money(p.item?.netPay)}</div>
                  <Badge className="bg-muted text-muted-foreground">{p.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No payslips yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function MyTraining() {
  const { data } = useMyTrainings();
  return (
    <Card>
      <CardContent className="pt-6">
        {data?.rows?.length ? (
          <ul className="divide-y">
            {data.rows.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <div>{t.program?.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t.program?.provider ?? 'Internal'} · enrolled {date(t.enrolledAt)}
                  </div>
                </div>
                <Badge className="bg-muted text-muted-foreground">{t.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            You are not enrolled on any training.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
