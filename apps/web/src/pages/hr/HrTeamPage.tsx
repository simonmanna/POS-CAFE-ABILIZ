import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useTeam,
  useTeamLeave,
  useTeamLeaveDecision,
  useTeamToday,
} from '@/features/hr/access-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { notify } from '@/lib/notify';
import { apiErrorMessage } from '@/lib/api-error';

const time = (d: string | null) => (d ? new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '—');
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('id-ID') : '—');

const TODAY_STYLE: Record<string, string> = {
  PRESENT: 'bg-emerald-100 text-emerald-800',
  LATE: 'bg-amber-100 text-amber-800',
  ON_LEAVE: 'bg-sky-100 text-sky-800',
  ABSENT: 'bg-rose-100 text-rose-800',
  EARLY_LEAVE: 'bg-orange-100 text-orange-800',
  OFF_DAY: 'bg-muted text-muted-foreground',
  NOT_CLOCKED_IN: 'bg-muted text-muted-foreground',
};

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

/**
 * Manager self-service.
 *
 * Scoped by the server to this manager's own direct reports and the departments
 * they manage — there is no permission to grant and no way to widen it from the
 * client, so a supervisor cannot use this to browse the wider organization.
 * Compensation is never included.
 */
export function HrTeamPage() {
  const [tab, setTab] = useState('today');
  const { data: today, isLoading: todayLoading } = useTeamToday();
  const { data: team } = useTeam();
  const { data: pending } = useTeamLeave('PENDING');
  const approve = useTeamLeaveDecision('approve');
  const reject = useTeamLeaveDecision('reject');

  const decide = async (kind: 'approve' | 'reject', id: string) => {
    const mutation = kind === 'approve' ? approve : reject;
    try {
      await mutation.mutateAsync({ id });
      notify.success(kind === 'approve' ? 'Leave approved' : 'Leave rejected');
    } catch (err) {
      notify.error(apiErrorMessage(err, `Could not ${kind} the request`));
    }
  };

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">My team</h1>
        <p className="text-sm text-muted-foreground">
          Your direct reports and anyone in a department you manage.
        </p>
      </div>

      {todayLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Team" value={today?.total ?? 0} />
          <Tile label="Present" value={today?.present ?? 0} />
          <Tile label="Late" value={today?.late ?? 0} />
          <Tile label="On leave" value={today?.onLeave ?? 0} />
          <Tile label="Absent" value={today?.absent ?? 0} />
          <Tile label="Not clocked in" value={today?.notClockedIn ?? 0} />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="leave">
            Leave requests
            {pending?.rows?.length ? (
              <Badge className="ml-1.5 bg-amber-100 text-amber-800">{pending.rows.length}</Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="today" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {today?.rows?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2">Employee</th>
                      <th className="py-2">Status</th>
                      <th className="py-2">In</th>
                      <th className="py-2">Out</th>
                      <th className="py-2 text-right">Late (min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {today.rows.map((r) => (
                      <tr key={r.employeeId} className="border-b last:border-0">
                        <td className="py-2">
                          <Link to={`/hr/employees/${r.employeeId}`} className="hover:underline">
                            {r.firstName} {r.lastName ?? ''}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {r.employeeCode}
                          </span>
                        </td>
                        <td className="py-2">
                          <Badge className={TODAY_STYLE[r.status] ?? 'bg-muted'}>
                            {r.status.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td className="py-2">{time(r.checkInAt)}</td>
                        <td className="py-2">{time(r.checkOutAt)}</td>
                        <td className="py-2 text-right">{r.lateMinutes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nobody reports to you yet. Team membership comes from the supervisor field on an
                  employee, or from managing a department.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="people" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {team?.rows?.length ? (
                <ul className="divide-y">
                  {team.rows.map((m: any) => (
                    <li key={m.id} className="flex items-center justify-between py-2.5">
                      <div>
                        <Link to={`/hr/employees/${m.id}`} className="text-sm hover:underline">
                          {m.firstName} {m.lastName ?? ''}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {m.position?.name ?? 'No position'}
                          {m.department?.name ? ` · ${m.department.name}` : ''}
                        </span>
                      </div>
                      <Badge className="bg-muted text-muted-foreground">
                        {String(m.employmentStatus ?? 'ACTIVE').replace(/_/g, ' ')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">No team members.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="leave" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Awaiting your decision</CardTitle>
            </CardHeader>
            <CardContent>
              {pending?.rows?.length ? (
                <ul className="divide-y">
                  {pending.rows.map((r: any) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <div>
                        <div className="text-sm font-medium">
                          {r.employee?.firstName} {r.employee?.lastName ?? ''}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {r.leaveType?.name}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {date(r.startDate)} → {date(r.endDate)} · {Number(r.days)} day(s)
                          {r.reason ? ` · ${r.reason}` : ''}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reject.isPending}
                          onClick={() => decide('reject', r.id)}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          disabled={approve.isPending}
                          onClick={() => decide('approve', r.id)}
                        >
                          Approve
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nothing waiting on you.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
