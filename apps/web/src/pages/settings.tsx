import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, UserPlus, KeyRound, Mail, Loader2, Check } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';

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
                  <div className="font-medium">{u.firstName} {u.lastName ?? ''}</div>
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
