/**
 * Cash Register Management — full lifecycle page.
 *
 * Covers:
 *   - Register selection (multi-register support)
 *   - Session state (open / closed)
 *   - Cash drawer audit trail
 *   - Cash in / Cash out
 *   - Shift close with variance
 *   - Variance explanation + approval
 *   - Banking deposit
 *   - Session history
 *   - Daily reconciliation report
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Banknote, Calculator, Check,
  CircleDollarSign, ClipboardList, Coins,
  History, LogOut, Minus, Plus,
  RefreshCw, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  useCashRegisters, useCloseShift, useDailyReconciliation, useOpenSession,
  useOpenShift, useRecordMovement, useSessionHistory,
  useSessionMovements, useUpdateVariance,
} from '../api';
import { HandoverDialog } from '../HandoverDialog';
import { usePosAuthStore } from '@/features/pos/pos-auth.store';
import type {
  CashMovementItem, CashRegister, CashSession,
  SessionHistoryItem,
} from '../types';
import '../pos-pro.css';

const fmt = (n: number | string | null | undefined) => `UGX ${Number(n || 0).toLocaleString()}`;

const todayIso = () => new Date().toISOString().slice(0, 10);

type Tab = 'register' | 'history' | 'reconciliation';

/* ==========================================================================
   Main Page
   ========================================================================== */

const CashRegistersPage: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('register');
  const [selectedRegisterId, setSelectedRegisterId] = useState<string>('');

  const { data: registers = [] } = useCashRegisters();
  const { data: openSession, refetch: refetchSession } = useOpenSession();
  const autoRegisterId = openSession?.cashRegisterId ?? registers[0]?.id ?? '';
  const registerId = selectedRegisterId || autoRegisterId;

  // If an open session exists, auto-select its register
  useEffect(() => {
    if (openSession?.cashRegisterId) {
      setSelectedRegisterId(openSession.cashRegisterId);
    }
  }, [openSession?.cashRegisterId]);

  const selectedRegister = registers.find((r: CashRegister) => r.id === registerId);

  return (
    <div className="pos-reports-shell">
      {/* Header */}
      <div className="pos-reports-header">
        <div>
          <Button variant="outline" size="sm" onClick={() => navigate('/pos/terminal')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Terminal
          </Button>
          <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
            <Banknote className="h-6 w-6" /> Cash Register Management
          </h1>
          <p className="text-sm text-slate-600">
            Manage registers, sessions, cash movements, and reconciliation.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetchSession()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="pos-reports-tabs pos-reports-tabs-wide">
        <button className={'pos-reports-tab' + (tab === 'register' ? ' active' : '')} onClick={() => setTab('register')}>
          <Banknote className="h-3.5 w-3.5 inline mr-1" /> Register
        </button>
        <button className={'pos-reports-tab' + (tab === 'history' ? ' active' : '')} onClick={() => setTab('history')}>
          <History className="h-3.5 w-3.5 inline mr-1" /> Session History
        </button>
        <button className={'pos-reports-tab' + (tab === 'reconciliation' ? ' active' : '')} onClick={() => setTab('reconciliation')}>
          <ClipboardList className="h-3.5 w-3.5 inline mr-1" /> Daily Reconciliation
        </button>
      </div>

      {/* Register selector */}
      {registers.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs whitespace-nowrap">Register:</Label>
          <select
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm font-semibold"
            value={registerId}
            onChange={(e) => setSelectedRegisterId(e.target.value)}
          >
            {registers.map((r: CashRegister) => (
              <option key={r.id} value={r.id}>{r.code} — {r.name}</option>
            ))}
          </select>
          {selectedRegister && (
            <span className="text-xs text-slate-500 ml-2">
              Register: {selectedRegister.name}
            </span>
          )}
        </div>
      )}

      {/* Tab content */}
      {tab === 'register' && (
        registerId ? (
          <RegisterView
            registerId={registerId}
            openSession={openSession as any}
            onSessionChange={() => refetchSession()}
          />
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
            <Banknote className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="font-semibold">No cash registers configured</p>
            <p className="text-xs mt-1">Ask a manager to create a cash register under Accounting.</p>
          </div>
        )
      )}

      {tab === 'history' && <SessionHistoryView registerId={registerId} />}
      {tab === 'reconciliation' && <ReconciliationView />}
    </div>
  );
};

/* ==========================================================================
   Register View — active session management
   ========================================================================== */

interface RegisterViewProps {
  registerId: string;
  openSession: CashSession | null;
  onSessionChange: () => void;
}

const RegisterView: React.FC<RegisterViewProps> = ({ registerId, openSession, onSessionChange }) => {
  const thisSession = openSession && openSession.cashRegisterId === registerId ? openSession : null;
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [showHandover, setShowHandover] = useState(false);
  const currentUserId = usePosAuthStore((s) => s.user?.userId);

  // Refresh when dialogs close
  const handleSessionChange = () => {
    setShowOpenShift(false);
    setShowCloseShift(false);
    setShowHandover(false);
    onSessionChange();
  };

  return (
    <div className="space-y-4">
      {thisSession ? (
        <>
          {/* Active session banner */}
          <div className="pos-shift-banner">
            <span>
              <span className="pos-active-dot inline-block mr-2" />
              Session open since {new Date(thisSession.openedAt!).toLocaleString()}
            </span>
            <span className="font-mono">Float: {fmt(thisSession.openingFloat)}</span>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
          <CashInOutButton sessionId={thisSession.id} onDone={onSessionChange} direction="pay_in" />
          <CashInOutButton sessionId={thisSession.id} onDone={onSessionChange} direction="pay_out" />
            <Button variant="outline" className="border-indigo-300 text-indigo-700" onClick={() => setShowHandover(true)}>
              <ArrowLeftRight className="h-4 w-4 mr-1" /> Handover
            </Button>
            <Button variant="outline" className="border-rose-300 text-rose-700" onClick={() => setShowCloseShift(true)}>
              <LogOut className="h-4 w-4 mr-1" /> Close register
            </Button>
          </div>

          {/* Drawer audit trail */}
          <CashDrawerAudit sessionId={thisSession.id} />
        </>
      ) : (
        <>
          {/* No open session */}
          <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
            <Power className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="font-semibold">Register is closed</p>
            <p className="text-xs mt-1 mb-4">Open this register to start recording cash movements and sales.</p>
            <Button onClick={() => setShowOpenShift(true)} style={{ background: '#16a34a' }}>
              <Calculator className="h-4 w-4 mr-1" /> Open register
            </Button>
          </div>

          {/* Past sessions for this register */}
          <div>
            <h3 className="text-sm font-bold text-slate-600 uppercase tracking-wide mb-2">Past sessions</h3>
            <RegisterSessionList registerId={registerId} />
          </div>
        </>
      )}

      {/* Dialogs */}
      <OpenShiftDialog
        open={showOpenShift}
        onClose={() => setShowOpenShift(false)}
        onOpened={handleSessionChange}
        preselectedRegisterId={registerId}
      />
      <CloseShiftDialog
        open={showCloseShift}
        session={thisSession}
        onClose={() => setShowCloseShift(false)}
        onClosed={handleSessionChange}
      />
      <HandoverDialog
        open={showHandover}
        session={thisSession}
        currentUserId={currentUserId}
        onClose={() => setShowHandover(false)}
        onDone={handleSessionChange}
      />
    </div>
  );
};

/* ==========================================================================
   Power icon (missing from lucide context)
   ========================================================================== */
const Power: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    <line x1="12" y1="2" x2="12" y2="12" />
  </svg>
);

/* ==========================================================================
   Cash In / Cash Out Button + Dialog
   ========================================================================== */

const CashInOutButton: React.FC<{
  sessionId: string;
  onDone: () => void;
  direction: 'pay_in' | 'pay_out';
}> = ({ sessionId, onDone, direction }) => {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const record = useRecordMovement();

  const handleSubmit = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (!reason.trim()) { toast.error('Enter a reason'); return; }
    try {
      await record.mutateAsync({
        sessionId,
        movementType: direction,
        amount: amt,
        reason: reason.trim(),
      });
      toast.success(direction === 'pay_in' ? 'Cash in recorded' : 'Cash out recorded');
      setOpen(false);
      setAmount('');
      setReason('');
      onDone();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to record movement');
    }
  };

  const isIn = direction === 'pay_in';

  return (
    <>
      <Button
        variant="outline"
        className={isIn ? 'border-emerald-300 text-emerald-700' : 'border-amber-300 text-amber-700'}
        onClick={() => setOpen(true)}
      >
        {isIn ? <Plus className="h-4 w-4 mr-1" /> : <Minus className="h-4 w-4 mr-1" />}
        {isIn ? 'Cash In' : 'Cash Out'}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2">
                {isIn ? <Plus className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-amber-600" />}
                {isIn ? 'Cash In' : 'Cash Out'}
              </h2>
              <button onClick={() => setOpen(false)}><X className="h-5 w-5 text-slate-400" /></button>
            </div>

            <div>
              <Label>Amount (UGX)</Label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />
            </div>

            <div>
              <Label>Reason</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isIn ? 'e.g. Added change money' : 'e.g. Purchased milk'} />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={record.isPending} style={{ background: isIn ? '#16a34a' : '#d97706' }}>
                {record.isPending ? 'Recording…' : isIn ? 'Record Cash In' : 'Record Cash Out'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

/* ==========================================================================
   Cash Drawer Audit Trail
   ========================================================================== */

const CashDrawerAudit: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { data, isLoading } = useSessionMovements(sessionId);

  if (isLoading) {
    return <div className="text-sm text-slate-500 p-4">Loading audit trail…</div>;
  }
  if (!data) {
    return <div className="text-sm text-slate-500 p-4">No data</div>;
  }

  const { session, movements } = data;

  const movementIcon = (type: string) => {
    switch (type) {
      case 'sale': return <CircleDollarSign className="h-3 w-3 text-emerald-600" />;
      case 'refund': return <ArrowRight className="h-3 w-3 text-rose-500" />;
      case 'pay_in': return <Plus className="h-3 w-3 text-emerald-600" />;
      case 'pay_out': return <Minus className="h-3 w-3 text-amber-600" />;
      case 'adjustment': return <Coins className="h-3 w-3 text-blue-600" />;
      default: return <Coins className="h-3 w-3" />;
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case 'sale': return 'Sale';
      case 'refund': return 'Refund';
      case 'pay_in': return 'Cash In';
      case 'pay_out': return 'Cash Out';
      case 'adjustment': return 'Adjustment';
      default: return type;
    }
  };

  return (
    <div className="pos-report-card">
      <h3>Cash Drawer Audit Trail</h3>

      {/* Session summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-xs">
        <div><span className="text-slate-500">Float:</span> <span className="font-bold">{fmt(session.openingFloat)}</span></div>
        {session.closingExpected && <div><span className="text-slate-500">Expected:</span> <span className="font-bold">{fmt(session.closingExpected)}</span></div>}
        {session.closingCounted && <div><span className="text-slate-500">Counted:</span> <span className="font-bold">{fmt(session.closingCounted)}</span></div>}
        {session.closingDifference && (
          <div>
            <span className="text-slate-500">Variance:</span>
            <span className={'font-bold ' + (Number(session.closingDifference) >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
              {fmt(session.closingDifference)}
            </span>
          </div>
        )}
      </div>

      {/* Movement table */}
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500 border-b border-slate-200 sticky top-0 bg-white">
            <tr>
              <th className="py-1.5 pr-2">Time</th>
              <th className="py-1.5 pr-2">Action</th>
              <th className="py-1.5 pr-2 text-right">Amount</th>
              <th className="py-1.5 pr-2 text-right">Balance</th>
              <th className="py-1.5 pr-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {/* Opening float row */}
            <tr className="border-b border-slate-100 text-slate-600">
              <td className="py-1.5 pr-2 font-mono">{session.openedAt ? new Date(session.openedAt).toLocaleTimeString() : ''}</td>
              <td className="py-1.5 pr-2 flex items-center gap-1">
                <Calculator className="h-3 w-3" /> Opening Float
              </td>
              <td className="py-1.5 pr-2 text-right font-mono font-bold">{fmt(session.openingFloat)}</td>
              <td className="py-1.5 pr-2 text-right font-mono">{fmt(session.openingFloat)}</td>
              <td className="py-1.5 pr-2 text-slate-400">—</td>
            </tr>
            {movements.map((m: CashMovementItem) => {
              const isNegative = m.movementType === 'refund' || m.movementType === 'pay_out';
              return (
                <tr key={m.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-2 font-mono text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</td>
                  <td className="py-1.5 pr-2 flex items-center gap-1">
                    {movementIcon(m.movementType)}
                    <span>{typeLabel(m.movementType)}</span>
                    {m.paymentMethod && <span className="text-slate-400">({m.paymentMethod})</span>}
                  </td>
                  <td className={'py-1.5 pr-2 text-right font-mono font-bold ' + (isNegative ? 'text-rose-600' : 'text-emerald-700')}>
                    {isNegative ? '-' : '+'}{fmt(m.amount)}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmt(m.runningTotal)}</td>
                  <td className="py-1.5 pr-2 text-slate-500 max-w-[200px] truncate" title={m.reason ?? ''}>
                    {m.reason ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ==========================================================================
   Open Shift Dialog (extended)
   ========================================================================== */

const OpenShiftDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onOpened: () => void;
  preselectedRegisterId?: string;
}> = ({ open, onClose, onOpened, preselectedRegisterId }) => {
  const { data: registers = [] } = useCashRegisters();
  const [registerId, setRegisterId] = useState(preselectedRegisterId || '');
  const [openingFloat, setOpeningFloat] = useState('50000');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const openShift = useOpenShift();

  useEffect(() => {
    if (open) {
      setRegisterId(preselectedRegisterId || registers[0]?.id || '');
      setOpeningFloat('50000');
      setNotes('');
      setErr(null);
    }
  }, [open, registers.length, preselectedRegisterId]);

  const submit = async () => {
    setErr(null);
    if (!registerId) { setErr('Pick a cash register'); return; }
    const float = Number(openingFloat);
    if (!Number.isFinite(float) || float < 0) { setErr('Opening float must be non-negative'); return; }
    try {
      await openShift.mutateAsync({ cashRegisterId: registerId, openingFloat: float, notes: notes.trim() || undefined });
      toast.success('Shift opened — you can now sell');
      onOpened();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to open shift');
    }
  };

  if (!open) return null;

  const QUICK_FLOATS = [0, 50000, 100000, 200000, 500000];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Power className="h-4 w-4 text-emerald-600" /> Open Register
          </h2>
          <button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button>
        </div>

        <div>
          <Label>Cash register</Label>
          {registers.length === 0 ? (
            <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2 mt-1">
              No active cash registers. Ask a manager to create one.
            </div>
          ) : (
            <select className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-md text-sm" value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
              {registers.map((r: CashRegister) => (
                <option key={r.id} value={r.id}>{r.code} — {r.name}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <Label>Opening float (UGX)</Label>
          <Input type="number" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} className="text-right text-lg h-11 font-mono font-bold" autoFocus />
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {QUICK_FLOATS.map((q) => (
              <button key={q} type="button" className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-xs font-bold" onClick={() => setOpeningFloat(String(q))}>
                {q === 0 ? 'No float' : q.toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label>Notes (optional)</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Morning shift" />
        </div>

        {err && <p className="text-sm text-rose-600">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={openShift.isPending || registers.length === 0} style={{ background: '#16a34a' }}>
            {openShift.isPending ? 'Opening…' : 'Open register'}
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ==========================================================================
   Close Shift Dialog (with cash count + variance)
   ========================================================================== */

const CloseShiftDialog: React.FC<{
  open: boolean;
  session: CashSession | null;
  onClose: () => void;
  onClosed: () => void;
}> = ({ open, session, onClose, onClosed }) => {
  const [counted, setCounted] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const closeShift = useCloseShift();
  const updateVariance = useUpdateVariance();

  useEffect(() => {
    if (open) { setCounted(''); setVarianceReason(''); setNotes(''); setErr(null); }
  }, [open]);

  if (!session) return null;

  const expectedCash = Number(session.closingExpected ?? session.openingFloat ?? 0);
  const countedNum = Number(counted);
  const variance = Number.isFinite(countedNum) ? countedNum - expectedCash : 0;

  const submit = async () => {
    setErr(null);
    if (!Number.isFinite(countedNum) || countedNum < 0) { setErr('Counted cash must be non-negative'); return; }
    try {
      const result = await closeShift.mutateAsync({ closingCounted: countedNum, notes: notes.trim() || undefined });
      // If there's a variance, save the reason
      if (variance !== 0 && varianceReason.trim()) {
        await updateVariance.mutateAsync({
          sessionId: result.id || session.id,
          reason: varianceReason.trim(),
          status: 'pending_review',
        });
      }
      toast.success(`Register closed. Variance: ${fmt(variance)}`);
      onClosed();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Failed to close register');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <LogOut className="h-4 w-4 text-rose-600" /> Close Register
          </h2>
          <button onClick={onClose}><X className="h-5 w-5 text-slate-400" /></button>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Opening float</span>
            <span className="font-mono">{fmt(session.openingFloat)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-600">Expected cash</span>
            <span className="font-mono font-bold">{fmt(expectedCash)}</span>
          </div>
        </div>

        <div>
          <Label>Counted cash (UGX)</Label>
          <Input type="number" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0" className="text-right text-xl h-12 font-mono font-bold" autoFocus />
        </div>

        {Number.isFinite(countedNum) && countedNum >= 0 && (
          <div className={
            'rounded-lg px-3 py-2 text-sm font-bold flex items-center gap-2 ' +
            (variance === 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
             variance > 0 ? 'bg-blue-50 text-blue-700 border border-blue-200' :
             'bg-rose-50 text-rose-700 border border-rose-200')
          }>
            {variance === 0 ? <Check className="h-4 w-4" /> : null}
            Variance: {variance >= 0 ? '+' : ''}{fmt(variance)}
            <span className="ml-auto font-normal text-xs opacity-75">
              {variance === 0 ? 'Drawer balanced' : variance > 0 ? 'Cashier is over' : 'Cashier is short'}
            </span>
          </div>
        )}

        {variance !== 0 && (
          <div>
            <Label>Variance explanation (required)</Label>
            <Input value={varianceReason} onChange={(e) => setVarianceReason(e.target.value)} placeholder="e.g. Gave excess change to customer" />
          </div>
        )}

        <div>
          <Label>Notes (optional)</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. End of morning shift" />
        </div>

        {err && <p className="text-sm text-rose-600">{err}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={closeShift.isPending} style={{ background: '#dc2626' }}>
            {closeShift.isPending ? 'Closing…' : 'Close register'}
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ==========================================================================
   Register Session List (past sessions for a register)
   ========================================================================== */

const RegisterSessionList: React.FC<{ registerId: string }> = ({ registerId }) => {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSessionHistory(page, 10, registerId);

  if (isLoading) return <div className="text-sm text-slate-500">Loading sessions…</div>;
  if (!data || data.data.length === 0) {
    return <div className="text-sm text-slate-400">No past sessions for this register.</div>;
  }

  return (
    <div className="pos-report-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-slate-200 text-slate-600">
              <th className="py-2 pr-3">Opened</th>
              <th className="py-2 pr-3">Closed</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3 text-right">Float</th>
              <th className="py-2 pr-3 text-right">Expected</th>
              <th className="py-2 pr-3 text-right">Counted</th>
              <th className="py-2 pr-3 text-right">Variance</th>
              <th className="py-2 pr-3">Movements</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((s: SessionHistoryItem) => {
              const diff = Number(s.closingDifference ?? 0);
              return (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-xs font-mono">{new Date(s.openedAt).toLocaleString()}</td>
                  <td className="py-2 pr-3 text-xs font-mono">{s.closedAt ? new Date(s.closedAt).toLocaleString() : '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={'px-2 py-0.5 rounded-full text-xs font-bold ' + (s.status === 'open' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>
                      {s.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.openingFloat)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">{s.closingExpected ? fmt(s.closingExpected) : '—'}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">{s.closingCounted ? fmt(s.closingCounted) : '—'}</td>
                  <td className={'py-2 pr-3 text-right font-mono text-xs font-bold ' + (diff >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                    {s.closingDifference ? fmt(s.closingDifference) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs">{s.movementCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-xs text-slate-500 self-center">Page {page} of {data.totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
};

/* ==========================================================================
   Session History View (full page)
   ========================================================================== */

const SessionHistoryView: React.FC<{ registerId: string }> = ({ registerId }) => {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSessionHistory(page, 20, registerId);

  return (
    <div className="space-y-4">
      <div className="pos-report-card">
        <h3>All Sessions {registerId ? ` — ${registerId}` : ''}</h3>
        {isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : !data || data.data.length === 0 ? (
          <div className="text-sm text-slate-400 py-4 text-center">No sessions found.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-slate-200 text-slate-600">
                    <th className="py-2 pr-3">Register</th>
                    <th className="py-2 pr-3">Opened</th>
                    <th className="py-2 pr-3">Closed</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Float</th>
                    <th className="py-2 pr-3 text-right">Expected</th>
                    <th className="py-2 pr-3 text-right">Counted</th>
                    <th className="py-2 pr-3 text-right">Variance</th>
                    <th className="py-2 pr-3">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((s: SessionHistoryItem) => {
                    const diff = Number(s.closingDifference ?? 0);
                    return (
                      <tr key={s.id} className="border-b border-slate-100">
                        <td className="py-2 pr-3 text-xs font-semibold">{s.cashRegister.code}</td>
                        <td className="py-2 pr-3 text-xs font-mono">{new Date(s.openedAt).toLocaleString()}</td>
                        <td className="py-2 pr-3 text-xs font-mono">{s.closedAt ? new Date(s.closedAt).toLocaleString() : '—'}</td>
                        <td className="py-2 pr-3">
                          <span className={'px-2 py-0.5 rounded-full text-xs font-bold ' + (s.status === 'open' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>
                            {s.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.openingFloat)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs">{s.closingExpected ? fmt(s.closingExpected) : '—'}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs">{s.closingCounted ? fmt(s.closingCounted) : '—'}</td>
                        <td className={'py-2 pr-3 text-right font-mono text-xs font-bold ' + (diff >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                          {s.closingDifference ? fmt(s.closingDifference) : '—'}
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-500 max-w-[150px] truncate">{s.notes || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-3">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                <span className="text-xs text-slate-500 self-center">Page {page} of {data.totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/* ==========================================================================
   Daily Reconciliation View
   ========================================================================== */

const ReconciliationView: React.FC = () => {
  const [date, setDate] = useState(todayIso());
  const { data, isLoading, refetch } = useDailyReconciliation(date);

  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div>
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="text-slate-500 p-4">Loading reconciliation…</div>
      ) : !data ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500">
          <ClipboardList className="h-10 w-10 mx-auto mb-2 opacity-50" />
          <p className="font-semibold">No data for {date}</p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="pos-report-grid">
            <ReportCard title="Opening float" value={fmt(t!.openingFloat)} sub={`${data.sessionCount} session${data.sessionCount === 1 ? '' : 's'}`} />
            <ReportCard title="Cash sales" value={fmt(t!.salesTotal)} />
            <ReportCard title="Cash in" value={fmt(t!.payInsTotal)} sub="Manual pay-ins" />
            <ReportCard title="Cash out" value={fmt(t!.payOutsTotal)} sub="Manual pay-outs" />
            <ReportCard title="Refunds" value={fmt(t!.refundsTotal)} />
            <ReportCard title="Banked" value={fmt(t!.bankedAmount)} />
            <ReportCard title="Expected cash" value={fmt(t!.expectedCash)} accent />
          </div>

          {/* Session breakdown */}
          {data.sessions.length > 0 && (
            <div className="pos-report-card">
              <h3>Session breakdown</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-slate-200 text-slate-600">
                      <th className="py-2 pr-3">Register</th>
                      <th className="py-2 pr-3">Float</th>
                      <th className="py-2 pr-3 text-right">Sales</th>
                      <th className="py-2 pr-3 text-right">Pay In</th>
                      <th className="py-2 pr-3 text-right">Pay Out</th>
                      <th className="py-2 pr-3 text-right">Refunds</th>
                      <th className="py-2 pr-3 text-right">Banked</th>
                      <th className="py-2 pr-3 text-right">Expected</th>
                      <th className="py-2 pr-3 text-right">Actual</th>
                      <th className="py-2 pr-3 text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s: any) => {
                      const v = Number(s.variance ?? 0);
                      return (
                        <tr key={s.sessionId} className="border-b border-slate-100">
                          <td className="py-2 pr-3 font-semibold text-xs">{s.cashRegisterName}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{fmt(s.openingFloat)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.salesTotal)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.payInsTotal)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.payOutsTotal)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.refundsTotal)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.bankedAmount)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{fmt(s.expectedCash)}</td>
                          <td className="py-2 pr-3 text-right font-mono text-xs">{s.actualCash ? fmt(s.actualCash) : '—'}</td>
                          <td className={'py-2 pr-3 text-right font-mono text-xs font-bold ' + (v >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                            {s.variance ? fmt(s.variance) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* ==========================================================================
   Shared ReportCard
   ========================================================================== */

const ReportCard: React.FC<{ title: string; value: string; sub?: string; accent?: boolean }> = ({ title, value, sub, accent }) => (
  <div className="pos-report-card">
    <h3>{title}</h3>
    <div className={'big ' + (accent ? 'text-emerald-600' : '')}>{value}</div>
    {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
  </div>
);

export default CashRegistersPage;
