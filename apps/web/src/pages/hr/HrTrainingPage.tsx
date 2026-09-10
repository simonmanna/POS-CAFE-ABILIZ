import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  useCreateProgram,
  useEnrol,
  useEnrolments,
  useTrainingPrograms,
  useUpdateEnrolment,
} from '@/features/hr/access-api';
import { useHrEmployees } from '@/features/hr/api';
import { Card, CardContent } from '@/components/ui/card';
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

const STATUS_STYLE: Record<string, string> = {
  ENROLLED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800',
  CANCELLED: 'bg-muted text-muted-foreground',
};

const NEXT_STATUS = ['ENROLLED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'];

/** Training programs and who is on them. */
export function HrTrainingPage() {
  const [tab, setTab] = useState('enrolments');
  const [programOpen, setProgramOpen] = useState(false);
  const [enrolOpen, setEnrolOpen] = useState(false);
  const { data: programs } = useTrainingPrograms();
  const { data: enrolments } = useEnrolments();
  const { data: employees } = useHrEmployees({ pageSize: 200 });
  const updateEnrolment = useUpdateEnrolment();

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Training</h1>
          <p className="text-sm text-muted-foreground">
            Programs, enrolments and completion.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setProgramOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New program
          </Button>
          <Button size="sm" onClick={() => setEnrolOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Enrol employee
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="enrolments">Enrolments</TabsTrigger>
          <TabsTrigger value="programs">Programs</TabsTrigger>
        </TabsList>

        <TabsContent value="enrolments" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {enrolments?.rows?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2">Employee</th>
                      <th className="py-2">Program</th>
                      <th className="py-2">Enrolled</th>
                      <th className="py-2">Completed</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrolments.rows.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <td className="py-2">
                          <Link to={`/hr/employees/${e.employeeId}`} className="hover:underline">
                            {e.employee?.firstName} {e.employee?.lastName ?? ''}
                          </Link>
                        </td>
                        <td className="py-2">{e.program?.name ?? '—'}</td>
                        <td className="py-2">{date(e.enrolledAt)}</td>
                        <td className="py-2">{date(e.completedAt)}</td>
                        <td className="py-2">
                          <select
                            className={`rounded border px-2 py-1 text-xs ${STATUS_STYLE[e.status] ?? 'bg-background'}`}
                            value={e.status}
                            onChange={async (ev) => {
                              try {
                                await updateEnrolment.mutateAsync({
                                  id: e.id,
                                  status: ev.target.value,
                                });
                                notify.success('Enrolment updated');
                              } catch (err) {
                                notify.error(apiErrorMessage(err, 'Could not update the enrolment'));
                              }
                            }}
                          >
                            {NEXT_STATUS.map((s) => (
                              <option key={s} value={s}>
                                {s.replace(/_/g, ' ')}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nobody is enrolled on training yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="programs" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {programs?.rows?.length ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2">Code</th>
                      <th className="py-2">Name</th>
                      <th className="py-2">Provider</th>
                      <th className="py-2 text-right">Hours</th>
                      <th className="py-2 text-right">Enrolled</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {programs.rows.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="py-2 font-mono text-xs">{p.code}</td>
                        <td className="py-2">{p.name}</td>
                        <td className="py-2">{p.provider ?? '—'}</td>
                        <td className="py-2 text-right">{p.durationHours ?? '—'}</td>
                        <td className="py-2 text-right">{p._count?.enrolments ?? 0}</td>
                        <td className="py-2">
                          <Badge
                            className={
                              p.isActive
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-muted text-muted-foreground'
                            }
                          >
                            {p.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No training programs defined.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ProgramDialog open={programOpen} onOpenChange={setProgramOpen} />
      <EnrolDialog
        open={enrolOpen}
        onOpenChange={setEnrolOpen}
        employees={employees?.rows ?? []}
        programs={programs?.rows ?? []}
      />
    </div>
  );
}

function ProgramDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const create = useCreateProgram();
  const [form, setForm] = useState({
    code: '',
    name: '',
    provider: '',
    durationHours: '',
    description: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New training program</DialogTitle>
          <DialogDescription>
            A course employees can be enrolled on. Programs with enrolments can be deactivated but
            not deleted, so the training history survives.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Code</Label>
              <Input value={form.code} onChange={(e) => set('code', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Duration (hours)</Label>
              <Input
                type="number"
                value={form.durationHours}
                onChange={(e) => set('durationHours', e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Provider</Label>
            <Input value={form.provider} onChange={(e) => set('provider', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !form.code || !form.name}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  code: form.code,
                  name: form.name,
                  provider: form.provider || undefined,
                  durationHours: form.durationHours ? Number(form.durationHours) : undefined,
                  description: form.description || undefined,
                } as any);
                notify.success('Program created');
                onOpenChange(false);
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not create the program'));
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnrolDialog({
  open,
  onOpenChange,
  employees,
  programs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employees: any[];
  programs: any[];
}) {
  const enrol = useEnrol();
  const [employeeId, setEmployeeId] = useState('');
  const [programId, setProgramId] = useState('');
  const [trainer, setTrainer] = useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol an employee</DialogTitle>
          <DialogDescription>
            Enrolling someone who has not finished the same program is rejected, so a half-done
            course cannot be quietly restarted.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Employee</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName ?? ''} ({e.employeeCode})
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Program</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
            >
              <option value="">Select…</option>
              {programs
                .filter((p) => p.isActive)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Trainer</Label>
            <Input value={trainer} onChange={(e) => setTrainer(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={enrol.isPending || !employeeId || !programId}
            onClick={async () => {
              try {
                await enrol.mutateAsync({
                  employeeId,
                  programId,
                  trainer: trainer || undefined,
                });
                notify.success('Employee enrolled');
                onOpenChange(false);
                setEmployeeId('');
                setProgramId('');
                setTrainer('');
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not enrol the employee'));
              }
            }}
          >
            Enrol
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
