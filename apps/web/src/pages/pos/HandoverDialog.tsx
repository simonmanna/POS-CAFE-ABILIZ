import { useAuthStore } from '@/stores/auth.store';
const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
// Shift-handover dialog (module 8). Hands the register from the outgoing cashier
// to the incoming one without closing the day: blind cash count + variance, the
// incoming cashier's PIN, and a manager PIN approval. Backend closes the
// outgoing session and opens a new one on the same register atomically.
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, AlertTriangle, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useShiftHandover, useExpectedCash } from './api';
import { useUsers } from '@/features/staff/api';
import { shiftTrackedAccounts, usePosPaymentMethods } from '@/features/pos/payment-accounts';
import { useSessionReconciliation } from '@/features/pos/session-reconciliation';
import { apiErrorMessage } from '@/lib/api-error';
import type { CashSession } from './types';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  session: CashSession | null;
  /** The cashier currently logged in at the terminal (excluded from the incoming list). */
  currentUserId?: string;
  onClose: () => void;
  onDone: () => void;
}

const fmt = (n: number | string | null | undefined) => `${orgCur()} ${Number(n || 0).toLocaleString()}`;

export const HandoverDialog: React.FC<Props> = ({ open, session, currentUserId, onClose, onDone }) => {
  const [counted, setCounted] = useState('');
  const [incomingUserId, setIncomingUserId] = useState('');
  const [incomingPin, setIncomingPin] = useState('');
  const [approvedById, setApprovedById] = useState('');
  const [managerPin, setManagerPin] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [accountCounts, setAccountCounts] = useState<Record<string, string>>({});
  const [uncounted, setUncounted] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const handover = useShiftHandover();
  const { data: expected } = useExpectedCash(open && session ? session.id : undefined);
  const { data: users } = useUsers({ page: 1, pageSize: 100 });
  const { data: paymentMethods = [] } = usePosPaymentMethods();
  const trackedAccounts = useMemo(() => shiftTrackedAccounts(paymentMethods), [paymentMethods]);
  const { data: recon } = useSessionReconciliation(open && session ? session.id : undefined, 20_000);
  const expectedByAccount = useMemo(
    () => new Map((recon?.accounts ?? []).map((a) => [a.accountId, Number(a.expected ?? 0)])),
    [recon],
  );

  useEffect(() => {
    if (open) {
      setCounted('');
      setIncomingUserId('');
      setIncomingPin('');
      setApprovedById('');
      setManagerPin('');
      setVarianceReason('');
      setAccountCounts({});
      setUncounted({});
      setErr(null);
    }
  }, [open]);

  const staff = useMemo(() => (users?.data ?? []).filter((u) => u.isActive), [users]);

  if (!session) return null;

  const expectedCash = Number(expected?.expectedCash ?? session.openingFloat ?? 0);
  const countedNum = Number(counted);
  const hasCount = Number.isFinite(countedNum) && countedNum >= 0;
  const variance = hasCount ? countedNum - expectedCash : 0;
  const needsReason = hasCount && variance !== 0;

  const submit = async () => {
    setErr(null);
    if (!hasCount) { setErr('Counted cash must be a non-negative number'); return; }
    if (!incomingUserId) { setErr('Select the incoming cashier'); return; }
    if (incomingUserId === currentUserId) { setErr('Incoming cashier must be different from the current one'); return; }
    if (!incomingPin) { setErr("Enter the incoming cashier's PIN"); return; }
    if (!approvedById) { setErr('Select the approving manager'); return; }
    if (!managerPin) { setErr("Enter the manager's PIN"); return; }
    if (approvedById === session.userId || approvedById === incomingUserId) { setErr('The approving manager must be neither the outgoing nor the incoming cashier'); return; }
    if (needsReason && !varianceReason.trim()) { setErr('A variance reason is required when the drawer is off'); return; }
    const closingAccounts: Record<string, number> = {};
    const uncountedAccounts: Record<string, string> = {};
    for (const a of trackedAccounts) {
      if (a.accountId in uncounted) {
        if (!uncounted[a.accountId].trim()) { setErr(`Say why ${a.label} was not checked`); return; }
        uncountedAccounts[a.accountId] = uncounted[a.accountId].trim();
      } else {
        const v = accountCounts[a.accountId];
        if (v == null || v.trim() === '' || !(Number(v) >= 0)) {
          if (expectedByAccount.get(a.accountId) === 0) { closingAccounts[a.accountId] = 0; continue; }
          setErr(`Enter what the provider shows for ${a.label}, or mark it not checked`);
          return;
        }
        closingAccounts[a.accountId] = Number(v);
      }
    }
    try {
      await handover.mutateAsync({
        cashRegisterId: session.cashRegisterId,
        closingCounted: countedNum,
        incomingUserId,
        incomingPin,
        approvedById,
        managerPin,
        varianceReason: varianceReason.trim() || undefined,
        closingAccounts: Object.keys(closingAccounts).length ? closingAccounts : undefined,
        uncountedAccounts: Object.keys(uncountedAccounts).length ? uncountedAccounts : undefined,
      });
      toast.success('Register handed over to the incoming cashier');
      onDone();
      onClose();
    } catch (e: any) {
      setErr(apiErrorMessage(e, 'Handover failed'));
    }
  };

  const selectCls = 'w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-indigo-600" /> Shift handover
          </DialogTitle>
          <DialogDescription>
            Hand the register to the next cashier without closing the day. The day's
            sales stay on the same register; the counted cash carries over as the opening float.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Expected cash</span>
            <span className="font-mono font-bold">{fmt(expectedCash)}</span>
          </div>
        </div>

        <div>
          <Label>Counted cash (blind count, {orgCur()})</Label>
          <Input
            type="number"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder="0"
            className="text-right text-xl h-12 font-mono font-bold"
            autoFocus
          />
        </div>

        {hasCount ? (
          <div
            className={
              'rounded-lg px-3 py-2 text-sm font-bold flex items-center gap-2 ' +
              (variance === 0
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : variance > 0
                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                  : 'bg-rose-50 text-rose-700 border border-rose-200')
            }
          >
            {variance === 0 ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            Variance: {variance >= 0 ? '+' : ''}{fmt(variance)}
            <span className="ml-auto font-normal text-xs opacity-75">
              {variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short'}
            </span>
          </div>
        ) : null}

        {needsReason ? (
          <div>
            <Label>Variance reason *</Label>
            <Input
              value={varianceReason}
              onChange={(e) => setVarianceReason(e.target.value)}
              placeholder="e.g. Gave excess change to a customer"
            />
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Incoming cashier</Label>
            <select className={selectCls} value={incomingUserId} onChange={(e) => setIncomingUserId(e.target.value)}>
              <option value="">Select…</option>
              {staff.filter((u) => u.id !== currentUserId).map((u) => (
                <option key={u.id} value={u.id}>{u.firstName}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Their PIN</Label>
            <Input type="password" inputMode="numeric" value={incomingPin} onChange={(e) => setIncomingPin(e.target.value)} placeholder="••••" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Approving manager</Label>
            <select className={selectCls} value={approvedById} onChange={(e) => setApprovedById(e.target.value)}>
              <option value="">Select…</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>{u.firstName}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Manager PIN</Label>
            <Input type="password" inputMode="numeric" value={managerPin} onChange={(e) => setManagerPin(e.target.value)} placeholder="••••" />
          </div>
        </div>

        {trackedAccounts.length ? (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Wallet and bank balances</p>
            {trackedAccounts.map((a) => (
              <div key={a.accountId} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-700">{a.label}</span>
                {a.accountId in uncounted ? (
                  <>
                    <Input
                      className="h-8 w-40 text-xs"
                      placeholder="Why not checked?"
                      value={uncounted[a.accountId]}
                      onChange={(e) => setUncounted((u) => ({ ...u, [a.accountId]: e.target.value }))}
                    />
                    <button type="button" className="text-[11px] font-semibold text-slate-500" onClick={() => setUncounted((u) => { const n = { ...u }; delete n[a.accountId]; return n; })}>Count</button>
                  </>
                ) : (
                  <>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 w-32 text-right font-mono text-xs"
                      placeholder="Provider shows"
                      value={accountCounts[a.accountId] ?? ''}
                      onChange={(e) => setAccountCounts((c) => ({ ...c, [a.accountId]: e.target.value }))}
                    />
                    <button type="button" className="text-[11px] font-semibold text-slate-500" onClick={() => setUncounted((u) => ({ ...u, [a.accountId]: '' }))}>Not checked</button>
                  </>
                )}
              </div>
            ))}
            <p className="text-[11px] text-slate-500">The counted cash carries over as the next cashier's opening float.</p>
          </div>
        ) : (
          <p className="text-xs text-slate-500">The counted cash carries over as the next cashier's opening float.</p>
        )}

        {err ? <p className="text-sm text-rose-600">{err}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={handover.isPending} style={{ background: '#4f46e5' }}>
            {handover.isPending ? 'Handing over…' : 'Hand over register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
