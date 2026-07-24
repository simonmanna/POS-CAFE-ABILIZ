import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, UserPlus, KeyRound, Mail, Loader2, Check, Boxes } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import { SystemConfigSection } from './settings/system-config';

const COSTING_METHODS = [
  { value: 'AVCO', label: 'Average Cost (AVCO)' },
  { value: 'FIFO', label: 'First-In, First-Out (FIFO)' },
  { value: 'STANDARD', label: 'Standard Cost' },
  { value: 'SPECIFIC', label: 'Specific Identification' },
] as const;

const PICKING_STRATEGIES = [
  { value: 'FEFO', label: 'FEFO — nearest expiry first' },
  { value: 'FIFO', label: 'FIFO — oldest receipt first' },
  { value: 'MANUAL', label: 'Manual batch selection' },
  { value: 'SERIAL', label: 'Serial selection' },
] as const;

interface InventoryDefaults {
  costingMethod: string | null;
  pickingStrategy: string | null;
  batchTracking: boolean;
  expiryTracking: boolean;
  serialTracking: boolean;
}

interface OrgDetails {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currencyCode: string;
}

interface OrgUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  roles: { id: string; name: string }[];
}

export function SettingsPage() {
  const qc = useQueryClient();
  const auth = useAuthStore();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirst, setInviteFirst] = useState('');
  const [inviteLast, setInviteLast] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');

  const org = useQuery<OrgDetails>({
    queryKey: ['organization-me'],
    queryFn: async () => (await api.get<OrgDetails>('/organizations/me')).data,
  });
  useEffect(() => {
    const data = org.data;
    if (data) {
      setName(data.name);
      setTimezone(data.timezone);
      setCurrencyCode(data.currencyCode);
    }
  }, [org.data]);
  const users = useQuery<OrgUser[]>({
    queryKey: ['organization-users'],
    queryFn: async () => (await api.get<OrgUser[]>('/organizations/users')).data,
  });
  const updateOrg = useMutation({
    mutationFn: async () => (await api.patch('/organizations/me/settings', { name, timezone, currencyCode })).data,
    onSuccess: (data: OrgDetails) => {
      notify.success('Organization updated');
      auth.setOrganization({
        id: data.id,
        code: data.code,
        name: data.name,
        currencyCode: data.currencyCode,
        timezone: data.timezone,
      });
      qc.invalidateQueries({ queryKey: ['organization-me'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });
  const invite = useMutation({
    mutationFn: async () =>
      (await api.post('/organizations/users/invite', {
        email: inviteEmail,
        firstName: inviteFirst,
        lastName: inviteLast || undefined,
      })).data,
    onSuccess: (data: any) => {
      notify.success('Invited', `Token: ${data.inviteToken?.slice(0, 12)}…`);
      setInviteOpen(false);
      setInviteEmail('');
      setInviteFirst('');
      setInviteLast('');
      qc.invalidateQueries({ queryKey: ['organization-users'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });
  const deactivate = useMutation({
    mutationFn: async (id: string) => await api.patch(`/organizations/users/${id}/deactivate`),
    onSuccess: () => {
      notify.success('Deactivated');
      qc.invalidateQueries({ queryKey: ['organization-users'] });
    },
  });
  const changePwd = useMutation({
    mutationFn: async () => (await api.post('/auth/change-password', { currentPassword: oldPwd, newPassword: newPwd })).data,
    onSuccess: () => {
      notify.success('Password changed — please sign in again');
      setPasswordOpen(false);
      setOldPwd('');
      setNewPwd('');
      auth.clear();
      window.location.href = '/login';
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  // ---- Inventory tracking defaults (org-level; new products inherit these) ----
  const [invCosting, setInvCosting] = useState('');
  const [invPicking, setInvPicking] = useState('FEFO');
  const [invBatch, setInvBatch] = useState(false);
  const [invExpiry, setInvExpiry] = useState(false);
  const [invSerial, setInvSerial] = useState(false);
  const invDefaults = useQuery<InventoryDefaults>({
    queryKey: ['inventory-defaults'],
    queryFn: async () => (await api.get<InventoryDefaults>('/settings/inventory-defaults')).data,
  });
  useEffect(() => {
    const d = invDefaults.data;
    if (d) {
      setInvCosting(d.costingMethod ?? '');
      setInvPicking(d.pickingStrategy ?? 'FEFO');
      setInvBatch(!!d.batchTracking);
      setInvExpiry(!!d.expiryTracking);
      setInvSerial(!!d.serialTracking);
    }
  }, [invDefaults.data]);
  const saveInvDefaults = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        batchTracking: invBatch,
        expiryTracking: invExpiry,
        serialTracking: invSerial,
      };
      if (invCosting) payload.costingMethod = invCosting;
      if (invPicking) payload.pickingStrategy = invPicking;
      return (await api.put('/settings/inventory-defaults', payload)).data;
    },
    onSuccess: () => {
      notify.success('Inventory defaults saved');
      qc.invalidateQueries({ queryKey: ['inventory-defaults'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>Tenant-wide settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {org.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium">Name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <label className="text-sm font-medium">Timezone</label>
                  <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="mt-1" />
                </div>
                <div>
                  <label className="text-sm font-medium">Currency</label>
                  <Input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="mt-1" />
                </div>
                <Button onClick={() => updateOrg.mutate()} disabled={updateOrg.isPending}>
                  {updateOrg.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>My account</CardTitle>
                <CardDescription>{auth.user?.email}</CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => setPasswordOpen(true)}>
                <KeyRound className="mr-2 h-3 w-3" />Change password
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Roles</span>
              <span>{auth.user?.roles?.join(', ') || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Permissions</span>
              <span>{auth.permissions.length}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-muted-foreground" />
              <div>
                <CardTitle>Inventory defaults</CardTitle>
                <CardDescription>Applied to new products that don't set their own tracking config.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {invDefaults.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Default costing method</label>
                  <Select value={invCosting} onValueChange={setInvCosting}>
                    <SelectTrigger><SelectValue placeholder="System default (AVCO)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">System default (AVCO)</SelectItem>
                      {COSTING_METHODS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Default picking strategy</label>
                  <Select value={invPicking} onValueChange={setInvPicking}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PICKING_STRATEGIES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2 flex flex-wrap gap-6">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={invBatch}
                      onChange={(e) => { setInvBatch(e.target.checked); if (!e.target.checked) setInvExpiry(false); }}
                    /> Batch tracking
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={invExpiry}
                      onChange={(e) => { setInvExpiry(e.target.checked); if (e.target.checked) setInvBatch(true); }}
                    /> Expiry tracking
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="rounded" checked={invSerial} onChange={(e) => setInvSerial(e.target.checked)} /> Serial tracking
                  </label>
                </div>
                <div>
                  <Button onClick={() => saveInvDefaults.mutate()} disabled={saveInvDefaults.isPending}>
                    {saveInvDefaults.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save defaults
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <SystemConfigSection />

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Users</CardTitle>
                <CardDescription>Manage who has access to this organization</CardDescription>
              </div>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus className="mr-2 h-3 w-3" />Invite
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {users.isLoading && <Skeleton className="h-24 w-full" />}
            {users.data?.map((u) => (
              <div key={u.id} className="flex items-center justify-between border-b py-2 last:border-b-0">
                <div>
                  <div className="font-medium">{u.firstName}</div>
                  <div className="text-xs text-muted-foreground">
                    {u.email} · {u.roles.map((r) => r.name).join(', ') || 'no role'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={u.isActive ? 'default' : 'outline'}>
                    {u.isActive ? 'active' : 'inactive'}
                  </Badge>
                  {u.isActive && u.id !== auth.user?.id && (
                    <Button size="sm" variant="ghost" onClick={() => deactivate.mutate(u.id)}>
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite user</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Email</label>
              <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-sm font-medium">First name</label>
                <Input value={inviteFirst} onChange={(e) => setInviteFirst(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Last name</label>
                <Input value={inviteLast} onChange={(e) => setInviteLast(e.target.value)} className="mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={() => invite.mutate()} disabled={!inviteEmail || !inviteFirst || invite.isPending}>
              <Mail className="mr-2 h-4 w-4" />Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog */}
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Current password</label>
              <Input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">New password (min 8 chars)</label>
              <Input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Button onClick={() => changePwd.mutate()} disabled={!oldPwd || newPwd.length < 8 || changePwd.isPending}>
              <Check className="mr-2 h-4 w-4" />Change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
