import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Search, UserPlus, User } from 'lucide-react';
import { posApi } from './api';
import type { Customer } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (c: Customer) => void;
}

export const CustomerDialog: React.FC<Props> = ({ open, onClose, onPick }) => {
  const [list, setList] = useState<Customer[]>([]);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ(''); setName(''); setPhone(''); setEmail(''); setErr(null);
    posApi.listCustomers().then(setList).catch(() => setList([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      posApi.listCustomers(q).then(setList).catch(() => setList([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const create = async () => {
    if (!name.trim()) return setErr('Name is required');
    try {
      setBusy(true);
      const c = await posApi.createCustomer({ name: name.trim(), phone: phone || undefined, email: email || undefined });
      onPick(c); onClose();
    } catch (e: any) { setErr(e?.response?.data?.message || 'Create failed'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><User className="h-4 w-4" /> Attach customer</DialogTitle>
          <DialogDescription>Search an existing customer or create a new one on the fly.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or phone…"
              className="pl-8"
            />
          </div>
          <div className="border rounded-lg max-h-[180px] overflow-y-auto">
            {list.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No customers found</p>
            ) : list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onPick(c); onClose(); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 border-b last:border-b-0"
              >
                <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center">
                  {(c.name || '?').split(' ').map((s) => s[0]).slice(0, 2).join('')}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold">{c.name}</div>
                  <div className="text-[11px] text-slate-500">{c.phone || c.email || '—'}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3">
          <p className="text-xs uppercase tracking-wider text-slate-500 font-bold mb-2 flex items-center gap-1">
            <UserPlus className="h-3 w-3" /> Create new
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Walk-in" />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0700…" />
            </div>
            <div className="col-span-2">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
            </div>
          </div>
          {err ? <p className="text-xs text-rose-600 mt-1">{err}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy || !name.trim()}>
            <UserPlus className="h-4 w-4 mr-1" /> Create & attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
