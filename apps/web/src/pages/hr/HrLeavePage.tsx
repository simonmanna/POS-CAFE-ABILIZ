import { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useHrLeaveRequests, useHrLeaveTypes, useHrLeaveBalances, useCreateHrLeaveRequest, useApproveHrLeaveRequest, useRejectHrLeaveRequest, useCancelHrLeaveRequest, useHrEmployees } from '@/features/hr/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { tx } from '@/lib/i18n/tx';

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-muted text-muted-foreground',
};

export function HrLeavePage() {
  const [tab, setTab] = useState('requests');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const { data: requests } = useHrLeaveRequests();
  const { data: types } = useHrLeaveTypes();
  const { data: balances } = useHrLeaveBalances();
  const { data: empData } = useHrEmployees({ pageSize: 200 });
  const create = useCreateHrLeaveRequest();
  const approve = useApproveHrLeaveRequest();
  const reject = useRejectHrLeaveRequest();
  const cancel = useCancelHrLeaveRequest();

  const rows = useMemo(() => requests?.rows ?? [], [requests]);
  const typeRows = useMemo(() => types?.rows ?? [], [types]);
  const balanceRows = useMemo(() => balances?.rows ?? [], [balances]);
  const employees = useMemo(() => empData?.rows ?? [], [empData]);

  const daysBetween = (s: string, e: string) =>
    Math.max(1, Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86400000) + 1);

  const doCreate = async () => {
    if (!form.employeeId || !form.leaveTypeId || !form.startDate || !form.endDate) return;
    await create.mutateAsync({
      employeeId: form.employeeId,
      leaveTypeId: form.leaveTypeId,
      startDate: form.startDate,
      endDate: form.endDate,
      reason: form.reason || undefined,
    });
    setOpen(false);
    setForm({});
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{tx('Leave')}</h1>
          <p className="text-sm text-muted-foreground">{tx('Requests, balances and leave types.')}</p>
        </div>
        <Button onClick={() => { setForm({}); setOpen(true); }}>{tx('New request')}</Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="requests">{tx('Requests')}</TabsTrigger>
          <TabsTrigger value="balances">{tx('Balances')}</TabsTrigger>
          <TabsTrigger value="types">{tx('Leave types')}</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="space-y-4">
          <Card>
            <CardHeader className="bg-muted/30 border-b rounded-t-lg">
              <CardTitle className="text-sm">{rows.length} {tx('requests')}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {rows.length === 0 && <p className="p-6 text-sm text-muted-foreground">{tx('No leave requests.')}</p>}
                {rows.map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/40">
                    <div className="flex items-center gap-3">
                      <CalendarDays className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{r.requestCode} · {r.employee?.employeeCode} {r.employee?.firstName}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.leaveType?.name} · {r.startDate} → {r.endDate} ({r.days} {tx('days)')}{r.reason ? ` · ${r.reason}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.status === 'PENDING' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => approve.mutate({ id: r.id })}>{tx('Approve')}</Button>
                          <Button size="sm" variant="outline" onClick={() => reject.mutate({ id: r.id })}>{tx('Reject')}</Button>
                        </>
                      )}
                      {r.status === 'PENDING' && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>{tx('Cancel')}</Button>}
                      <Badge variant="outline" className={STATUS_STYLE[r.status] ?? ''}>{r.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="balances" className="space-y-4">
          <Card>
            <CardHeader className="bg-muted/30 border-b rounded-t-lg">
              <CardTitle className="text-sm">{balanceRows.length} {tx('balances ·')} {new Date().getFullYear()}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {balanceRows.length === 0 && <p className="p-6 text-sm text-muted-foreground">{tx('No balances yet — they are created when the first request is approved or via the API.')}</p>}
                {balanceRows.map((b: any) => {
                  const remaining = Number(b.accruedDays) + Number(b.adjustedDays) - Number(b.usedDays);
                  return (
                    <div key={b.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{b.employee?.employeeCode} {b.employee?.firstName} · {b.leaveType?.name}</p>
                        <p className="text-xs text-muted-foreground">{b.year} · {Number(b.accruedDays)} {tx('accrued +')} {Number(b.adjustedDays)} {tx('adjusted −')} {Number(b.usedDays)} {tx('used')}</p>
                      </div>
                      <span className={`text-sm font-semibold ${remaining < 0 ? 'text-rose-600' : ''}`}>{remaining} {tx('left')}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="types" className="space-y-4">
          <Card>
            <CardHeader className="bg-muted/30 border-b rounded-t-lg">
              <CardTitle className="text-sm">{typeRows.length} {tx('leave types')}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {typeRows.length === 0 && <p className="p-6 text-sm text-muted-foreground">{tx('No leave types configured.')}</p>}
                {typeRows.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{t.code} · {t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.daysPerYear} {tx('days/yr ·')} {t.isPaid ? 'paid' : 'unpaid'} {tx('· carry-over')} {t.carryForwardDays}
                        {t.maxConsecutiveDays ? ` · max ${t.maxConsecutiveDays} consecutive` : ''}
                      </p>
                    </div>
                    {!t.isActive && <Badge variant="outline" className="bg-muted text-muted-foreground">{tx('Inactive')}</Badge>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New request dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{tx('New leave request')}</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label>{tx('Employee *')}</Label>
              <select value={form.employeeId ?? ''} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm">
                <option value="">{tx('Select employee…')}</option>
                {employees.map((e: any) => <option key={e.id} value={e.id}>{e.employeeCode} · {e.firstName}{e.lastName ? ' ' + e.lastName : ''}</option>)}
              </select>
            </div>
            <div>
              <Label>{tx('Leave type *')}</Label>
              <select value={form.leaveTypeId ?? ''} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm">
                <option value="">{tx('Select type…')}</option>
                {typeRows.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{tx('Start *')}</Label>
                <Input type="date" value={form.startDate ?? ''} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </div>
              <div>
                <Label>{tx('End *')}</Label>
                <Input type="date" value={form.endDate ?? ''} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </div>
            </div>
            {form.startDate && form.endDate && (
              <p className="text-xs text-muted-foreground">{daysBetween(form.startDate, form.endDate)} {tx('day(s) requested')}</p>
            )}
            <div>
              <Label>{tx('Reason')}</Label>
              <Input value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <Button onClick={doCreate} disabled={create.isPending}>{tx('Submit request')}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
