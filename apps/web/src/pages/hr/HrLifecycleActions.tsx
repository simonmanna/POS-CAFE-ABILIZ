import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  useConfirmEmployee,
  useReactivateEmployee,
  useSuspendEmployee,
  useTerminateEmployee,
  useTransferEmployee,
  type HrAccess,
  type HrEmploymentStatus,
} from '@/features/hr/access-api';
import { useHrDepartments, useHrPositions } from '@/features/hr/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { notify } from '@/lib/notify';
import { apiErrorMessage } from '@/lib/api-error';

type Action = 'terminate' | 'suspend' | 'reactivate' | 'confirm' | 'transfer' | null;

const ENDED: HrEmploymentStatus[] = ['TERMINATED', 'RESIGNED'];

/**
 * Lifecycle actions on the Employee 360 header.
 *
 * Everything here is consequential and audited, so each action asks for a
 * reason and states plainly what will happen — in particular that historical
 * records are never rewritten, which is the question an administrator actually
 * has when they hesitate over a Terminate button.
 *
 * Whether the login is disabled is an explicit checkbox rather than an implied
 * side effect. The server requires the flag too; this is not the only guard.
 */
export function HrLifecycleActions({
  employee,
  access,
}: {
  employee: any;
  access?: HrAccess;
}) {
  const [action, setAction] = useState<Action>(null);
  const status: HrEmploymentStatus = employee.employmentStatus ?? 'ACTIVE';
  const ended = ENDED.includes(status);
  const suspended = status === 'SUSPENDED';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <MoreHorizontal className="mr-1.5 h-4 w-4" />
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {status === 'PROBATION' && (
            <DropdownMenuItem onSelect={() => setAction('confirm')}>
              Confirm (probation passed)
            </DropdownMenuItem>
          )}
          {!ended && !suspended && (
            <DropdownMenuItem onSelect={() => setAction('transfer')}>Transfer…</DropdownMenuItem>
          )}
          {!ended && !suspended && (
            <DropdownMenuItem onSelect={() => setAction('suspend')}>Suspend…</DropdownMenuItem>
          )}
          {(ended || suspended) && (
            <DropdownMenuItem onSelect={() => setAction('reactivate')}>
              {ended ? 'Rehire…' : 'Lift suspension…'}
            </DropdownMenuItem>
          )}
          {!ended && (
            <DropdownMenuItem
              onSelect={() => setAction('terminate')}
              className="text-rose-600 focus:text-rose-600"
            >
              End employment…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TerminateDialog
        open={action === 'terminate'}
        onClose={() => setAction(null)}
        employee={employee}
        hasAccount={!!access?.linked}
      />
      <SuspendDialog
        open={action === 'suspend'}
        onClose={() => setAction(null)}
        employee={employee}
        hasAccount={!!access?.linked}
      />
      <ReactivateDialog
        open={action === 'reactivate'}
        onClose={() => setAction(null)}
        employee={employee}
        hasAccount={!!access?.linked}
        wasTerminated={ended}
      />
      <ConfirmDialog
        open={action === 'confirm'}
        onClose={() => setAction(null)}
        employee={employee}
      />
      <TransferDialog
        open={action === 'transfer'}
        onClose={() => setAction(null)}
        employee={employee}
      />
    </>
  );
}

function useReason() {
  const [reason, setReason] = useState('');
  return { reason, setReason, valid: reason.trim().length >= 3 };
}

function TerminateDialog({
  open,
  onClose,
  employee,
  hasAccount,
}: {
  open: boolean;
  onClose: () => void;
  employee: any;
  hasAccount: boolean;
}) {
  const { reason, setReason, valid } = useReason();
  const [disableAccount, setDisableAccount] = useState(true);
  const [resigned, setResigned] = useState(false);
  const [terminationDate, setTerminationDate] = useState('');
  const terminate = useTerminateEmployee();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End employment</DialogTitle>
          <DialogDescription>
            Records that {employee.firstName} has left. Their orders, invoices, payments, cash
            sessions and audit history are <strong>not</strong> changed — they stay attributed to
            this person, and the record remains readable as a former employee.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Last working day</Label>
            <Input
              type="date"
              value={terminationDate}
              onChange={(e) => setTerminationDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={resigned}
              onChange={(e) => setResigned(e.target.checked)}
            />
            They resigned (voluntary departure)
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={disableAccount}
              onChange={(e) => setDisableAccount(e.target.checked)}
              disabled={!hasAccount}
              className="mt-0.5"
            />
            <span>
              Disable their login immediately
              {hasAccount ? (
                <span className="block text-xs text-muted-foreground">
                  Signs them out everywhere, and the revocation reaches offline terminals on their
                  next sync so the PIN stops working there too.
                </span>
              ) : (
                <span className="block text-xs text-muted-foreground">
                  This employee has no linked login.
                </span>
              )}
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!valid || terminate.isPending}
            onClick={async () => {
              try {
                await terminate.mutateAsync({
                  employeeId: employee.id,
                  reason,
                  disableAccount: hasAccount ? disableAccount : false,
                  resigned,
                  terminationDate: terminationDate || undefined,
                });
                notify.success('Employment ended');
                onClose();
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not end employment'));
              }
            }}
          >
            End employment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuspendDialog({
  open,
  onClose,
  employee,
  hasAccount,
}: {
  open: boolean;
  onClose: () => void;
  employee: any;
  hasAccount: boolean;
}) {
  const { reason, setReason, valid } = useReason();
  const [disableAccount, setDisableAccount] = useState(true);
  const suspend = useSuspendEmployee();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend {employee.firstName}</DialogTitle>
          <DialogDescription>
            Suspension is not termination: employment continues, and payroll, leave balances and
            history are untouched. Use it to pause access while something is investigated.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={disableAccount}
              onChange={(e) => setDisableAccount(e.target.checked)}
              disabled={!hasAccount}
            />
            Disable their login while suspended
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || suspend.isPending}
            onClick={async () => {
              try {
                await suspend.mutateAsync({
                  employeeId: employee.id,
                  reason,
                  disableAccount: hasAccount ? disableAccount : false,
                });
                notify.success('Employee suspended');
                onClose();
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not suspend the employee'));
              }
            }}
          >
            Suspend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReactivateDialog({
  open,
  onClose,
  employee,
  hasAccount,
  wasTerminated,
}: {
  open: boolean;
  onClose: () => void;
  employee: any;
  hasAccount: boolean;
  wasTerminated: boolean;
}) {
  const { reason, setReason } = useReason();
  const [enableAccount, setEnableAccount] = useState(true);
  const [toProbation, setToProbation] = useState(false);
  const reactivate = useReactivateEmployee();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{wasTerminated ? 'Rehire' : 'Lift suspension'}</DialogTitle>
          <DialogDescription>
            {wasTerminated
              ? 'Brings this person back on the same record, so their earlier service history stays with them rather than starting a duplicate employee.'
              : 'Returns this employee to active status.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Reason (optional)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
          {wasTerminated && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={toProbation}
                onChange={(e) => setToProbation(e.target.checked)}
              />
              Start on probation
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={enableAccount}
              onChange={(e) => setEnableAccount(e.target.checked)}
              disabled={!hasAccount}
              className="mt-0.5"
            />
            <span>
              Re-enable their login
              <span className="block text-xs text-muted-foreground">
                Opt-in on purpose — the account may have been disabled for an unrelated reason.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={reactivate.isPending}
            onClick={async () => {
              try {
                await reactivate.mutateAsync({
                  employeeId: employee.id,
                  reason: reason || undefined,
                  enableAccount: hasAccount ? enableAccount : false,
                  toProbation,
                });
                notify.success(wasTerminated ? 'Employee rehired' : 'Suspension lifted');
                onClose();
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not reactivate the employee'));
              }
            }}
          >
            {wasTerminated ? 'Rehire' : 'Reactivate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: any;
}) {
  const { reason, setReason } = useReason();
  const confirm = useConfirmEmployee();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm {employee.firstName}</DialogTitle>
          <DialogDescription>Marks probation as passed and records the date.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label>Note (optional)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={confirm.isPending}
            onClick={async () => {
              try {
                await confirm.mutateAsync({
                  employeeId: employee.id,
                  reason: reason || undefined,
                });
                notify.success('Employee confirmed');
                onClose();
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not confirm the employee'));
              }
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: any;
}) {
  const { reason, setReason, valid } = useReason();
  const [toDepartmentId, setToDepartmentId] = useState('');
  const [toPositionId, setToPositionId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const { data: departments } = useHrDepartments();
  const { data: positions } = useHrPositions();
  const transfer = useTransferEmployee();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer {employee.firstName}</DialogTitle>
          <DialogDescription>
            Changes where they work from now on. Past transactions keep the branch and department
            they actually happened in — nothing historical is rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Department</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={toDepartmentId}
              onChange={(e) => setToDepartmentId(e.target.value)}
            >
              <option value="">Keep current</option>
              {(departments?.rows ?? []).map((d: any) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Position</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={toPositionId}
              onChange={(e) => setToPositionId(e.target.value)}
            >
              <option value="">Keep current</option>
              {(positions?.rows ?? []).map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Effective date</Label>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || transfer.isPending || (!toDepartmentId && !toPositionId)}
            onClick={async () => {
              try {
                await transfer.mutateAsync({
                  employeeId: employee.id,
                  toDepartmentId: toDepartmentId || undefined,
                  toPositionId: toPositionId || undefined,
                  effectiveDate: effectiveDate || undefined,
                  reason,
                });
                notify.success('Employee transferred');
                onClose();
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not transfer the employee'));
              }
            }}
          >
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
