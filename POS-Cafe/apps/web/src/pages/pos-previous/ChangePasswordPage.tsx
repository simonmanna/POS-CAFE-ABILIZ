// src/pages/pos/ChangePasswordPage.tsx
import React, { useState } from 'react';
import api from '../../services/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const ChangePasswordPage: React.FC = () => {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (next.length < 8) return toast.error('Password must be at least 8 characters');
    if (next !== confirm) return toast.error('Passwords do not match');
    try {
      setSaving(true);
      await api.post('/auth/change-password', { currentPassword: current || undefined, newPassword: next });
      toast.success('Password changed. Please log in again.');
      setTimeout(() => logout('manual'), 800);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to change password');
    } finally { setSaving(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> Change password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-500">Signed in as <b>{user?.name}</b> ({user?.role})</p>
          <div>
            <Label>Current password</Label>
            <Input type="password" value={current} onChange={e => setCurrent(e.target.value)} />
          </div>
          <div>
            <Label>New password</Label>
            <Input type="password" value={next} onChange={e => setNext(e.target.value)} />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </div>
          <Button className="w-full" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Change password'}</Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default ChangePasswordPage;
