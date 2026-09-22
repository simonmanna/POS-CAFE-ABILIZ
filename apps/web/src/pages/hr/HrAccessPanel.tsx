import { useState } from 'react';
import { KeyRound, Link2, Link2Off, ShieldCheck, UserPlus } from 'lucide-react';
import {
  useClearEmployeePin,
  useHrAccess,
  useHrLinkableUsers,
  useLinkUser,
  useProvisionUser,
  useSetEmployeePin,
  useUnlinkUser,
} from '@/features/hr/access-api';
import { SetPinDialog } from '@/pages/staff/SetPinDialog';
import { useRoles } from '@/features/staff/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('id-ID') : 'Never';

/**
 * The System Access panel of the Employee 360.
 *
 * This is the screen the whole identity spine exists to make possible: one
 * place where an administrator can see whether a person can log in, what they
 * can do, and whether they can operate the POS — without cross-referencing the
 * Staff list by hand.
 *
 * Two things it deliberately never shows: a password and a PIN. `hasPin` is a
 * boolean from the server; the hash never leaves it.
 */
export function HrAccessPanel({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const { data: access, isLoading } = useHrAccess(employeeId);
  const [linkOpen, setLinkOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);

  const unlink = useUnlinkUser();
  const setPin = useSetEmployeePin();
  const clearPin = useClearEmployeePin();

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading access…</p>;

  const user = access?.user;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">System access</CardTitle>
          {access?.linked ? (
            <Badge className="bg-emerald-100 text-emerald-800">Linked</Badge>
          ) : (
            <Badge className="bg-muted text-muted-foreground">Not linked</Badge>
          )}
        </CardHeader>

        <CardContent>
          {access?.linked && user ? (
            <div className="space-y-4">
              <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                <Row label="Username" value={user.email} />
                <Row
                  label="Account"
                  value={
                    user.isActive ? (
                      <span className="text-emerald-700">Active</span>
                    ) : (
                      <span className="text-rose-700">Disabled</span>
                    )
                  }
                />
                <Row label="Roles" value={user.roles.map((r) => r.name).join(', ') || 'None'} />
                <Row
                  label="POS access"
                  value={
                    user.posAccess ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <ShieldCheck className="h-3.5 w-3.5" /> Yes
                      </span>
                    ) : (
                      'No'
                    )
                  }
                />
                <Row
                  label="POS PIN"
                  value={
                    user.hasPin ? (
                      <span className="inline-flex items-center gap-1">
                        <KeyRound className="h-3.5 w-3.5" /> Set
                      </span>
                    ) : (
                      'Not set'
                    )
                  }
                />
                <Row label="Last login" value={dateTime(user.lastLoginAt)} />
                {user.lockedUntil && (
                  <Row
                    label="Locked until"
                    value={<span className="text-rose-700">{dateTime(user.lockedUntil)}</span>}
                  />
                )}
              </dl>

              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button size="sm" variant="outline" onClick={() => setPinOpen(true)}>
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                  {user.hasPin ? 'Reset POS PIN' : 'Set POS PIN'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUnlinkOpen(true)}
                  disabled={unlink.isPending}
                >
                  <Link2Off className="mr-1.5 h-3.5 w-3.5" />
                  Unlink account
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Roles decide what this person can do. Employment status adds one rule on top: while
                someone is suspended or has left, they cannot sign in at a POS till, even if their
                login is still enabled. Change roles from the Staff screen.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {employeeName} has no login. They exist in HR but cannot sign in to the back office
                or the POS.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setLinkOpen(true)}>
                  <Link2 className="mr-1.5 h-3.5 w-3.5" />
                  Link existing account
                </Button>
                <Button size="sm" variant="outline" onClick={() => setProvisionOpen(true)}>
                  <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                  Create account
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <LinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        employeeId={employeeId}
        employeeName={employeeName}
      />
      <ProvisionDialog
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        employeeId={employeeId}
        employeeName={employeeName}
      />
      <SetPinDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        personName={employeeName}
        hasPin={!!user?.hasPin}
        pending={setPin.isPending || clearPin.isPending}
        onSave={(pin) => setPin.mutateAsync({ employeeId, pin })}
        onClear={() => clearPin.mutateAsync(employeeId)}
      />

      <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlink account?</DialogTitle>
            <DialogDescription>
              This detaches the login from {employeeName}. The account itself is not disabled or
              deleted, and their past orders, invoices and cash sessions are untouched — those keep
              resolving to the same person. To stop someone signing in, terminate or suspend them
              instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlinkOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                try {
                  await unlink.mutateAsync(employeeId);
                  notify.success('Account unlinked');
                  setUnlinkOpen(false);
                } catch (err) {
                  notify.error(apiErrorMessage(err, 'Could not unlink the account'));
                }
              }}
              disabled={unlink.isPending}
            >
              Unlink
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b py-2 sm:border-0 sm:py-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function LinkDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employeeId: string;
  employeeName: string;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useHrLinkableUsers(search || undefined);
  const link = useLinkUser();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link an account to {employeeName}</DialogTitle>
          <DialogDescription>
            Only accounts that are not already attached to another employee are listed, so one login
            can never back two people.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
            {isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && !data?.rows?.length && (
              <p className="p-3 text-sm text-muted-foreground">
                No unlinked accounts. Every active login already belongs to an employee.
              </p>
            )}
            {data?.rows?.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setSelected(u.id)}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-muted ${
                  selected === u.id ? 'bg-muted ring-1 ring-primary' : ''
                }`}
              >
                <span>
                  <span className="font-medium">
                    {u.firstName} {u.lastName ?? ''}
                  </span>
                  <span className="block text-xs text-muted-foreground">{u.email}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {u.roles.map((r) => r.name).join(', ') || 'No roles'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selected || link.isPending}
            onClick={async () => {
              if (!selected) return;
              try {
                await link.mutateAsync({ employeeId, userId: selected });
                notify.success('Account linked');
                onOpenChange(false);
                setSelected(null);
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not link the account'));
              }
            }}
          >
            Link account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employeeId: string;
  employeeName: string;
}) {
  const { data: roles } = useRoles();
  const provision = useProvisionUser();
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    roleIds: [] as string[],
  });

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  // useRoles returns the array directly.
  const roleRows = roles ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a login for {employeeName}</DialogTitle>
          <DialogDescription>
            Creates the account through the same path as the Staff screen and links it. Roles decide
            POS access — pick a POS role if this person works a till.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Email</Label>
            <Input value={form.email} onChange={(e) => set('email', e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Temporary password</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">At least 10 characters.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>First name</Label>
              <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Last name</Label>
              <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Roles</Label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {roleRows.map((r: any) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.roleIds.includes(r.id)}
                    onChange={(e) =>
                      set(
                        'roleIds',
                        e.target.checked
                          ? [...form.roleIds, r.id]
                          : form.roleIds.filter((x) => x !== r.id),
                      )
                    }
                  />
                  {r.name}
                </label>
              ))}
              {roleRows.length === 0 && (
                <p className="text-sm text-muted-foreground">No roles available.</p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              provision.isPending ||
              !form.email ||
              form.password.length < 10 ||
              !form.firstName ||
              form.roleIds.length === 0
            }
            onClick={async () => {
              try {
                await provision.mutateAsync({
                  employeeId,
                  email: form.email,
                  password: form.password,
                  firstName: form.firstName,
                  lastName: form.lastName || undefined,
                  roleIds: form.roleIds,
                });
                notify.success('Account created and linked');
                onOpenChange(false);
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not create the account'));
              }
            }}
          >
            Create and link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
