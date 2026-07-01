// Multi-tender payment dialog. Maps directly to POST /pos/checkout with `tenders`.
// Quick-amount buttons, change calculation, manager override for high discounts.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote, Smartphone, CreditCard, Building2, Wallet, Check, X, Plus, Gift,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PaymentMethod, PaymentTender } from './types';

/** The pay panel offers the tender methods PLUS a non-tender "settle on account"
 *  mode (credit_settlement) that books the sale to the customer's AR instead of
 *  collecting money now. It is routed to onCreditSale, not added as a tender. */
type SettleMode = PaymentMethod | 'credit_settlement';
type MethodTile = { key: SettleMode; label: string; icon: React.ReactNode; color: string };

const METHODS: MethodTile[] = [
  { key: 'cash', label: 'Cash', icon: <Banknote className="h-4 w-4" />, color: '#16a34a' },
  { key: 'mobile_money', label: 'Mobile Money', icon: <Smartphone className="h-4 w-4" />, color: '#f59e0b' },
  { key: 'card', label: 'Card', icon: <CreditCard className="h-4 w-4" />, color: '#1a7fcf' },
  { key: 'bank', label: 'Bank', icon: <Building2 className="h-4 w-4" />, color: '#8b5cf6' },
];

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;

interface Props {
  open: boolean;
  total: number;
  /** Highest discount percentage currently applied (line + transaction). */
  effectiveDiscountPercent?: number;
  /** Selected customer's redeemable store-credit balance (0 / undefined hides it). */
  storeCreditBalance?: number;
  /** Called by parent when the cashier needs to verify a manager. */
  onRequestOverride: (kind: 'discount' | 'void' | 'manual_refund') => Promise<string | null>;
  onClose: () => void;
  onSettle: (input: {
    tenders: PaymentTender[];
    transactionDiscountPercent: number;
    overrideById?: string;
  }) => Promise<void>;
  /** Enables the "Charge to account" (postpaid credit) action — true when a real customer is selected. */
  creditEnabled?: boolean;
  /** Runs the credit (postpaid AR) sale through the Order→Invoice→Receipt pipeline. */
  onCreditSale?: () => Promise<void>;
}

const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000, 100000];

export const PaymentDialog: React.FC<Props> = ({
  open, total, effectiveDiscountPercent = 0, storeCreditBalance = 0, onRequestOverride, onClose, onSettle,
  creditEnabled = false, onCreditSale,
}) => {
  const [tenders, setTenders] = useState<PaymentTender[]>([]);
  const [activeMethod, setActiveMethod] = useState<SettleMode>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideId, setOverrideId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setTenders([]); setTendered(''); setReference(''); setError(null); setOverrideId(undefined);
    setActiveMethod('cash');
  }, [open]);

  // Store-credit tile only appears when the selected customer carries a balance.
  // Credit-settlement ("On Account") appears whenever a real customer is selected.
  const methods = useMemo(() => {
    const base = [...METHODS];
    if (storeCreditBalance > 0) {
      base.push({ key: 'store_credit', label: 'Store Credit', icon: <Gift className="h-4 w-4" />, color: '#0ea5e9' });
    }
    if (creditEnabled && onCreditSale) {
      base.push({ key: 'credit_settlement', label: 'On Account', icon: <Wallet className="h-4 w-4" />, color: '#0284c7' });
    }
    return base;
  }, [storeCreditBalance, creditEnabled, onCreditSale]);

  const isCredit = activeMethod === 'credit_settlement';

  const paid = useMemo(() => tenders.reduce((s, t) => s + (t.amount || 0), 0), [tenders]);
  const remaining = Math.max(0, total - paid);
  const change = paid > total ? paid - total : 0;
  const creditUsed = useMemo(
    () => tenders.filter((t) => t.method === 'store_credit').reduce((s, t) => s + t.amount, 0),
    [tenders],
  );
  const availableCredit = Math.max(0, storeCreditBalance - creditUsed);
  const tenderNum = Number(tendered);
  const tenderValid = Number.isFinite(tenderNum) && tenderNum > 0;
  const creditBlocked = activeMethod === 'store_credit' && availableCredit <= 0;

  const addTender = () => {
    // credit_settlement is not a tender — it's routed to onCreditSale instead.
    if (activeMethod === 'credit_settlement') return;
    if (!tenderValid || remaining <= 0 || creditBlocked) return;
    let amount = Math.min(tenderNum, remaining);
    if (activeMethod === 'store_credit') amount = Math.min(amount, availableCredit);
    if (amount <= 0) return;
    const method: PaymentMethod = activeMethod;
    setTenders((prev) => [
      ...prev,
      {
        method,
        amount,
        reference: reference.trim() || undefined,
      },
    ]);
    setTendered(''); setReference('');
  };

  const removeTender = (i: number) => setTenders((prev) => prev.filter((_, idx) => idx !== i));

  const canSettle = tenders.length > 0 && paid >= total - 0.01;

  const settle = async () => {
    if (!canSettle) return;
    try {
      setBusy(true); setError(null);
      await onSettle({
        tenders,
        transactionDiscountPercent: 0,
        overrideById: overrideId,
      });
    } catch (e: any) {
      setError(e?.message || e?.response?.data?.message || 'Payment failed');
    } finally {
      setBusy(false);
    }
  };

  // Settle on account: no money collected now — books the sale to the customer's
  // AR (postpaid) via the credit pipeline. Routed to the parent, not a tender.
  const settleOnAccount = async () => {
    if (!onCreditSale) return;
    try {
      setBusy(true); setError(null);
      await onCreditSale();
    } catch (e: any) {
      setError(e?.message || e?.response?.data?.message || 'Credit settlement failed');
    } finally {
      setBusy(false);
    }
  };

  const requestOverride = async () => {
    const mgrId = await onRequestOverride('discount');
    if (mgrId) setOverrideId(mgrId);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[760px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-emerald-500 to-emerald-700 text-white p-4">
          <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Charge
          </DialogTitle>
          <DialogDescription className="text-emerald-100 text-xs">
            Pay with one or many methods. Split by adding tenders until the total is covered.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px]">
          <div className="p-4 space-y-3">
            {/* Method tabs */}
            <div className="grid grid-cols-4 gap-2">
              {methods.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className="flex flex-col items-center gap-1 p-2.5 rounded-lg border-2 transition-all"
                  style={{
                    borderColor: activeMethod === m.key ? m.color : '#e2e8f0',
                    background: activeMethod === m.key ? `${m.color}15` : '#fff',
                    color: activeMethod === m.key ? m.color : '#64748b',
                  }}
                  onClick={() => setActiveMethod(m.key)}
                >
                  {m.icon}
                  <span className="text-[11px] font-bold">{m.label}</span>
                </button>
              ))}
            </div>

            {isCredit ? (
              <div className="rounded-lg border-2 border-sky-200 bg-sky-50 p-4 space-y-1.5">
                <div className="flex items-center gap-2 text-sky-800 font-bold text-sm">
                  <Wallet className="h-4 w-4" /> Settle on account (credit)
                </div>
                <p className="text-xs text-sky-700">
                  No money is collected now. {fmt(total)} is booked to the customer's
                  account (AR) and settled later by a payment.
                </p>
              </div>
            ) : (
            <>
            <div>
              <Label>{activeMethod === 'cash' ? 'Cash tendered' : 'Amount to charge'}</Label>
              <Input
                type="number"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder="0"
                className="text-right text-xl h-12 font-mono font-bold"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') addTender(); }}
              />
              {activeMethod === 'cash' ? (
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {QUICK_AMOUNTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-xs font-bold"
                      onClick={() => setTendered(String(q))}
                    >
                      {q.toLocaleString()}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="px-2.5 py-1 rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200 text-xs font-bold"
                    onClick={() => setTendered(String(total))}
                  >
                    Exact
                  </button>
                </div>
              ) : null}
              {activeMethod === 'store_credit' ? (
                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className="font-semibold text-sky-700">Available credit: {fmt(availableCredit)}</span>
                  <button
                    type="button"
                    className="px-2.5 py-1 rounded-md bg-sky-100 text-sky-700 hover:bg-sky-200 font-bold disabled:opacity-50"
                    disabled={availableCredit <= 0}
                    onClick={() => setTendered(String(Math.min(remaining, availableCredit)))}
                  >
                    Use max
                  </button>
                </div>
              ) : null}
            </div>

            {activeMethod !== 'cash' && activeMethod !== 'store_credit' ? (
              <div>
                <Label>Reference / transaction id (optional)</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. MTN-12345"
                  className="font-mono"
                />
              </div>
            ) : null}

            <Button onClick={addTender} disabled={!tenderValid || remaining <= 0 || creditBlocked} className="w-full" style={{ background: methods.find((m) => m.key === activeMethod)?.color }}>
              <Plus className="h-4 w-4 mr-1" /> Add {methods.find((m) => m.key === activeMethod)?.label} — {fmt(Math.min(tenderValid ? tenderNum : remaining, activeMethod === 'store_credit' ? Math.min(remaining, availableCredit) : remaining))}
            </Button>
            </>
            )}

            {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          </div>

          {/* Right column: total + tenders + settle */}
          <div className="bg-slate-50 border-l border-slate-200 p-4 flex flex-col">
            <div className="text-center mb-3">
              <div className="text-xs uppercase tracking-wider text-slate-500">Total due</div>
              <div className="text-3xl font-extrabold text-slate-800 mt-1">{fmt(total)}</div>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span>Paid</span><span className="font-mono">{fmt(paid)}</span></div>
              <div className="flex justify-between font-bold text-emerald-600"><span>Remaining</span><span className="font-mono">{fmt(remaining)}</span></div>
              {change > 0 ? (
                <div className="flex justify-between font-bold text-amber-600"><span>Change</span><span className="font-mono">{fmt(change)}</span></div>
              ) : null}
            </div>
            <div className="mt-3 flex-1 overflow-y-auto space-y-1.5">
              {tenders.length === 0 ? (
                <p className="text-xs text-slate-400 text-center mt-4">No tenders yet</p>
              ) : tenders.map((t, i) => (
                <div key={i} className="flex items-center justify-between bg-white rounded border border-slate-200 px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: methods.find((m) => m.key === t.method)?.color }} />
                    <span className="font-bold">{t.method.replace('_', ' ')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold">{fmt(t.amount)}</span>
                    <button type="button" onClick={() => removeTender(i)} className="text-rose-500 hover:text-rose-700"><X className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>

            {/* Optional manager override indicator (already verified upstream via parent) */}
            {overrideId ? (
              <div className="mt-2 text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-2 py-1">
                ✓ Manager override applied
              </div>
            ) : null}

            <Button
              onClick={isCredit ? settleOnAccount : settle}
              disabled={busy || (isCredit ? !creditEnabled : !canSettle)}
              className="w-full mt-3 h-12 text-base"
              style={{ background: isCredit ? '#0284c7' : '#16a34a' }}
            >
              {busy
                ? 'Processing…'
                : isCredit
                  ? <><Wallet className="h-4 w-4 mr-1" /> Charge {fmt(total)} to account</>
                  : <><Check className="h-4 w-4 mr-1" /> Settle {fmt(total)}</>}
            </Button>
          </div>
        </div>

        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* Hidden helper — if discount > 10% and no override, allow cashier to request one */}
          {effectiveDiscountPercent > 10 && !overrideId ? (
            <Button onClick={requestOverride} variant="outline" className="border-amber-300 text-amber-700">
              Request manager override
            </Button>
          ) : null}
          {/* Postpaid credit is now a payment mode ("On Account") in the method grid. */}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};