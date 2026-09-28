/**
 * Shift-close dialog — a three-step walk-through: Check → Count → Confirm.
 *
 * The closing amounts are visible from the first step: the expected drawer cash
 * and every wallet/bank account figure are shown up front, so the cashier knows
 * what the shift should finish with before sealing it. The count is therefore a
 * verification against a known target rather than a blind guess; the drawer
 * difference is still only revealed once the count is committed. What changed is
 * everything around that rule — readiness problems are explained in plain
 * language before the count starts, the numpad shows its own arithmetic, and
 * every server refusal is translated into a sentence that says what to do next
 * instead of echoing an API message.
 *
 * Provider balances are never RE-typed from scratch: the POS already knows what
 * it took into each wallet/bank account, so the confirm step shows opening,
 * received, refunds and the expected figure for every account. Confirming the
 * balance the provider actually shows is optional per account — blank means
 * "not checked", exactly as at shift open — and only then is a variance claimed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PowerOff, AlertTriangle, Check, ShieldCheck, Calculator, RefreshCw,
  CircleCheck, Info, ArrowLeft, ArrowRight, Loader2, Trash2, Printer, CloudUpload,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCloseShift } from './api';
import {
  buildClosingStatementHtml, buildClosingStatementText, type ClosingStatementInput,
} from './closing-statement';
import { api } from '@/lib/api';
import {
  useSessionReconciliation, closeBlockers, blockerCount, tenderAccountRows,
} from '@/features/pos/session-reconciliation';
import {
  blockingOperationsForSession, replaySale, retryAndSyncFailed, discardFailed,
  type QueuedSale, type FailedSale,
} from '@/features/pos/offline-queue';
import { shiftTrackedAccounts, usePosPaymentMethods } from '@/features/pos/payment-accounts';
import { useAuthStore } from '@/stores/auth.store';
import type { CashSession } from './types';
import { toast } from 'sonner';

const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
const fmt = (n: number | string | null | undefined) => `${orgCur()} ${Number(n || 0).toLocaleString()}`;
const plain = (n: number | string | null | undefined) => Number(n || 0).toLocaleString();

// Common UGX note/coin faces, largest first.
const DENOMS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];

/** Screen-only height bounds for the closing-summary paper (px). */
const PAPER_MIN_H = 320;
const PAPER_MAX_H = 660;

type Step = 'check' | 'count' | 'confirm' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'check', label: 'Check' },
  { key: 'count', label: 'Count' },
  { key: 'confirm', label: 'Confirm' },
];

interface Props {
  open: boolean;
  session: CashSession | null;
  onClose: () => void;
  onClosed: () => void;
}

/* ----------------------------------------------------------------- notices */

type Tone = 'ok' | 'warn' | 'error' | 'info';

const TONES: Record<Tone, { box: string; icon: string }> = {
  ok: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: 'text-emerald-600' },
  warn: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: 'text-amber-600' },
  error: { box: 'border-rose-200 bg-rose-50 text-rose-900', icon: 'text-rose-600' },
  info: { box: 'border-slate-200 bg-slate-50 text-slate-700', icon: 'text-slate-500' },
};

const Notice: React.FC<{ tone: Tone; title: string; children?: React.ReactNode }> = ({ tone, title, children }) => {
  const t = TONES[tone];
  const Icon = tone === 'ok' ? CircleCheck : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${t.box}`}>
      <p className="flex items-center gap-2 font-bold">
        <Icon className={`h-4 w-4 shrink-0 ${t.icon}`} /> {title}
      </p>
      {children ? <div className="mt-1 space-y-1 pl-6 text-[13px] leading-snug">{children}</div> : null}
    </div>
  );
};

/* ------------------------------------------------- device-queue resolution */

const opLabel = (op: QueuedSale | FailedSale): string => {
  const ep: string = op.endpoint ?? '/pos/checkout';
  if (/checkout$/.test(ep)) return 'Sale payment';
  if (/settle$/.test(ep)) return 'Table settlement';
  if (/refund$/.test(ep)) return 'Refund';
  if (/items$/.test(ep)) return 'Kitchen round';
  if (/payments$/.test(ep)) return 'Credit collection';
  if (/write-off$/.test(ep)) return 'Write-off';
  return ep.replace(/^\/+|\/+$/g, '') || 'Operation';
};

const opAmount = (op: QueuedSale | FailedSale): number | null => {
  const tenders = op.payload?.tenders;
  if (Array.isArray(tenders) && tenders.length > 0) {
    return tenders.reduce((s: number, t: any) => s + (Number(t?.amount) || 0), 0);
  }
  for (const k of ['amount', 'grossAmount', 'totalAmount']) {
    const n = Number(op.payload?.[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};

/** One stuck payment with its resolve actions, rendered inside the check step. */
const DeviceOpRow: React.FC<{
  op: QueuedSale | FailedSale;
  busy: boolean;
  confirmingDiscard: boolean;
  onStartDiscard: () => void;
  onCancelDiscard: () => void;
  onSync: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}> = ({ op, busy, confirmingDiscard, onStartDiscard, onCancelDiscard, onSync, onRetry, onDiscard }) => {
  const failed = !!(op as FailedSale).failedAt;
  const amount = opAmount(op);
  return (
    <li className="rounded border border-amber-200 bg-white/70 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          {opLabel(op)}
          {amount != null ? ` · ${orgCur()} ${Number(amount).toLocaleString()}` : ''}
        </span>
        <span className="text-[11px] text-slate-500">{new Date(op.createdAt).toLocaleTimeString()}</span>
      </div>
      {failed ? (
        <p className="mt-0.5 text-[12px] text-rose-700 break-words">
          {(op as FailedSale).httpStatus ? `HTTP ${(op as FailedSale).httpStatus} — ` : ''}
          {(op as FailedSale).rejection?.message || (op as FailedSale).lastError || 'Rejected by the server'}
        </p>
      ) : op.lastError ? (
        <p className="mt-0.5 text-[12px] text-slate-600 break-words">{op.lastError}</p>
      ) : null}
      <div className="mt-1.5 flex justify-end gap-2">
        {failed ? (
          <>
            {confirmingDiscard ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDiscard}
                  className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" /> Discard forever
                </button>
                <button
                  type="button"
                  onClick={onCancelDiscard}
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Keep
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <RefreshCw className="h-3 w-3" /> Retry sync
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onStartDiscard}
                  className="rounded-md border border-rose-300 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                >
                  Discard…
                </button>
              </>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onSync}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudUpload className="h-3 w-3" />}
            Sync now
          </button>
        )}
      </div>
    </li>
  );
};

/* --------------------------------------------------- server-error decoding */

interface Decoded {
  tone: Tone;
  title: string;
  detail: string;
  /** Step to send the cashier back to so they can actually fix it. */
  goTo?: Step;
  revealManager?: boolean;
  focusReason?: boolean;
}

/**
 * The API speaks in constraints; a cashier at 11pm needs a next action. Every
 * branch here names the thing to do, not the rule that was broken.
 */
export function decodeError(body: unknown): Decoded {
  const data = (body && typeof body === 'object' ? body : { message: body }) as {
    code?: string; message?: string | string[]; openOrderCount?: number;
    accounts?: Array<{ name?: string; expected?: string; observed?: string; difference?: string }>;
  };
  const msg = (Array.isArray(data.message) ? data.message.join('; ') : data.message) || 'Something went wrong while closing the shift';
  // Structured codes first; the regexes below remain for older servers.
  switch (data.code) {
    case 'PROVIDER_BALANCE_VARIANCE': {
      const lines = (data.accounts ?? []).map((a) => {
        const d = Number(a.difference ?? 0);
        return `${a.name ?? 'Account'}: expected ${Number(a.expected ?? 0).toLocaleString()}, entered ${Number(a.observed ?? 0).toLocaleString()} (${d > 0 ? '+' : ''}${d.toLocaleString()})`;
      });
      return {
        tone: 'warn',
        title: 'A wallet or bank balance does not match',
        detail: `${lines.length ? lines.join('. ') + '. ' : ''}Re-check the figure, or write why it differs and ask a manager to approve below.`,
        goTo: 'confirm',
        focusReason: true,
        revealManager: true,
      };
    }
    case 'OPEN_ORDERS':
      return {
        tone: 'warn',
        title: 'There are still open orders',
        detail: `${data.openOrderCount ?? 'Some'} open order(s) must be settled or voided before the shift can close. The list below shows them.`,
        goTo: 'check',
      };
    case 'RECONCILIATION_ISSUES':
      return {
        tone: 'warn',
        title: 'There is still open work on this shift',
        detail: 'The list below shows what is left. Clear it, tap Check again, then come back.',
        goTo: 'check',
      };
    case 'CASH_VARIANCE_REASON_REQUIRED':
      return {
        tone: 'warn',
        title: 'The drawer does not balance',
        detail: 'That is fine — it happens. Write one line about why, and we can finish closing.',
        goTo: 'confirm',
        focusReason: true,
      };
    case 'MANAGER_APPROVAL_REQUIRED':
      return {
        tone: 'warn',
        title: 'This needs a manager',
        detail: 'Ask a manager to enter their email and PIN below, then close the shift again.',
        goTo: 'confirm',
        revealManager: true,
      };
    case 'TENDER_NOT_COUNTED':
      return { tone: 'error', title: 'Check every wallet and bank account', detail: msg, goTo: 'confirm' };
  }
  if (/variance reason/i.test(msg)) {
    return {
      tone: 'warn',
      title: 'The drawer does not balance',
      detail: 'That is fine — it happens. Write one line about why, and we can finish closing.',
      goTo: 'confirm',
      focusReason: true,
    };
  }
  if (/manager approval|approver|manager pin|approve/i.test(msg)) {
    return {
      tone: 'warn',
      title: 'This difference is large enough to need a manager',
      detail: 'Ask a manager to enter their email and PIN below, then close the shift again.',
      goTo: 'confirm',
      revealManager: true,
    };
  }
  if (/unsettled order|pending payment|posting difference|Resolve unsettled/i.test(msg)) {
    return {
      tone: 'warn',
      title: 'There is still open work on this shift',
      detail: 'The list below shows what is left. Clear it, tap Check again, then come back.',
      goTo: 'check',
    };
  }
  if (/pending device operation|pending or rejected payments/i.test(msg)) {
    return {
      tone: 'warn',
      title: 'This device still has payments waiting to sync',
      detail: 'The list below shows each one. Sync it, or retry/discard it if the server rejected it, then close the shift.',
      goTo: 'check',
    };
  }
  if (/previous drawer operation/i.test(msg)) {
    return {
      tone: 'warn',
      title: 'An earlier drawer action never got a reply',
      detail: 'Retry that one first with its original amount — the pending-operation notice at the top right has it.',
      goTo: 'check',
    };
  }
  if (/no open cash session/i.test(msg)) {
    return {
      tone: 'error',
      title: 'This register is not open any more',
      detail: 'Someone may have closed it already. Refresh the page to see where it stands.',
    };
  }
  if (/negative/i.test(msg)) {
    return {
      tone: 'error',
      title: 'The counted amount cannot be negative',
      detail: 'Enter the cash actually in the drawer — use 0 if the drawer is empty.',
      goTo: 'count',
    };
  }
  if (/network|timeout|Network Error/i.test(msg)) {
    return {
      tone: 'error',
      title: 'Could not reach the server',
      detail: 'Your count has not been lost. Check the connection and try closing again.',
    };
  }
  return { tone: 'error', title: 'The shift could not be closed', detail: msg };
}

/* ------------------------------------------------------------------ dialog */

export const ShiftCloseDialog: React.FC<Props> = ({ open, session, onClose, onClosed }) => {
  const [step, setStep] = useState<Step>('check');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  /** Provider balances the cashier chose to confirm, accountId → amount. */
  const [accountCounts, setAccountCounts] = useState<Record<string, number>>({});
  /** Tracked accounts the cashier could not check, accountId → reason (needs a manager). */
  const [uncounted, setUncounted] = useState<Record<string, string>>({});
  const [byDenom, setByDenom] = useState(false);
  const [denom, setDenom] = useState<Record<number, string>>({});
  const [showManager, setShowManager] = useState(false);
  const [approverEmail, setApproverEmail] = useState('');
  const [managerPin, setManagerPin] = useState('');
  /** When accepted, a counted-short / counted-over drawer difference is booked as a withdrawal / cash-in movement. */
  const [autoAdjustCash, setAutoAdjustCash] = useState(true);
  const [problem, setProblem] = useState<Decoded | null>(null);
  const [result, setResult] = useState<CashSession | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const closeShift = useCloseShift();
  const { data: paymentMethods = [] } = usePosPaymentMethods();
  // Poll faster than the register page: the cashier is standing here waiting
  // for open orders to clear.
  const { data: recon, isFetching: checking, refetch: recheck } = useSessionReconciliation(
    open && session ? session.id : undefined,
    10_000,
  );

  /* Device-local payments bound to this shift: unsynced sales and rejected
   * sales not marked safeToRetry. The server cannot see these — its
   * reconciliation can read "all clear" while the close gate still refuses —
   * so the check step surfaces them here and resolves them in place. */
  const [deviceOps, setDeviceOps] = useState<Array<QueuedSale | FailedSale>>([]);
  const [deviceOpsLoaded, setDeviceOpsLoaded] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const sessionId = session?.id;
  const refreshDeviceOps = useCallback(async () => {
    if (!sessionId) return;
    setDeviceOps(await blockingOperationsForSession(sessionId));
    setDeviceOpsLoaded(true);
  }, [sessionId]);

  useEffect(() => {
    if (!open || step !== 'check' || !sessionId) return;
    void refreshDeviceOps();
    const id = setInterval(refreshDeviceOps, 5000);
    return () => clearInterval(id);
  }, [open, step, refreshDeviceOps, sessionId]);

  const syncOne = async (op: QueuedSale) => {
    setBusyOp(op.idempotencyKey);
    try {
      const outcome = await replaySale(op);
      if (outcome.status === 'identity') toast.warning('This payment was queued under a different organization — it cannot be synced from this sign-in.');
      else if (outcome.status === 'ok') toast.success('Payment synced');
      else if (outcome.status === 'rejected') toast.info('The server rejected it — review it in the list.');
      else toast.error('Could not reach the server. The payment stays queued.');
      await refreshDeviceOps();
      void recheck();
    } finally {
      setBusyOp(null);
    }
  };

  const retryOne = async (op: FailedSale) => {
    setBusyOp(op.idempotencyKey);
    try {
      const outcome = await retryAndSyncFailed(op);
      if (outcome.status === 'ok') toast.success('Payment synced');
      else if (outcome.status === 'rejected') toast.info('The server rejected it again — see the reason in the list.');
      else if (outcome.status === 'identity') toast.warning('This payment was queued under a different organization — it cannot be synced from this sign-in.');
      else toast.error('Could not reach the server. The payment stays queued.');
      await refreshDeviceOps();
      void recheck();
    } finally {
      setBusyOp(null);
    }
  };

  const discardOne = async (op: FailedSale) => {
    setBusyOp(op.idempotencyKey);
    try {
      await discardFailed(op.idempotencyKey);
      toast.warning('Rejected payment discarded permanently');
      await refreshDeviceOps();
    } finally {
      setBusyOp(null);
      setConfirmDiscard(null);
    }
  };

  useEffect(() => {
    if (open) {
      setStep('check');
      setCounted(''); setNotes(''); setVarianceReason('');
      setAccountCounts({});
      setUncounted({});
      setByDenom(false); setDenom({});
      setShowManager(false); setApproverEmail(''); setManagerPin('');
      setAutoAdjustCash(true);
      setProblem(null); setResult(null);
      setDeviceOps([]); setDeviceOpsLoaded(false); setBusyOp(null); setConfirmDiscard(null);
    }
  }, [open]);

  useEffect(() => {
    if (problem?.focusReason) reasonRef.current?.focus();
  }, [problem]);

  const denomTotal = useMemo(
    () => DENOMS.reduce((s, face) => s + face * (parseInt(denom[face] || '0', 10) || 0), 0),
    [denom],
  );
  const denomPieces = useMemo(
    () => DENOMS.reduce((s, face) => s + (parseInt(denom[face] || '0', 10) || 0), 0),
    [denom],
  );

  // When counting by denomination, the grid drives the counted total.
  const countedNum = byDenom ? denomTotal : Number(counted);
  const countedValid = Number.isFinite(countedNum) && countedNum >= 0 && (byDenom || counted.trim() !== '');

  const blockers = closeBlockers(recon);
  const problemCount = blockerCount(blockers);
  // Unsynced device payments do NOT gate the close — the count is verified
  // against the server's books. They surface for a best-effort sync below and
  // keep retrying on their own after the shift is sealed.
  const ready = !!recon && blockers.length === 0 && deviceOpsLoaded;

  // Per-account movement for every wallet/bank account this till collects into.
  const trackedAccounts = useMemo(() => shiftTrackedAccounts(paymentMethods), [paymentMethods]);
  const accountRows = useMemo(
    () => tenderAccountRows({
      accounts: trackedAccounts,
      recon,
      openingAccounts: (session as any)?.openingAccounts,
      counted: accountCounts,
    }),
    [trackedAccounts, recon, session, accountCounts],
  );

  useEffect(() => {
    setAccountCounts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const row of accountRows) {
        if (!(row.accountId in next) && row.expected === 0) { next[row.accountId] = 0; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [accountRows]);

  /* The closing summary is built as soon as the shift closes and previewed on
   * the done step — the same shape as the receipt / bill / KOT flow: the paper
   * is shown, nothing is printed until the cashier asks for it. It lives INSIDE
   * this dialog rather than in a second one, because a modal opened on top of a
   * modal is the one thing a cashier standing at the till never sees.
   *
   * These hooks must stay above the `!session` early return (Rules of Hooks);
   * the builder is defined below, so it is reached through a ref. */
  const [statement, setStatement] = useState<ClosingStatementInput | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [paperH, setPaperH] = useState(PAPER_MIN_H);
  const paperRef = useRef<HTMLIFrameElement>(null);
  const builtOnce = useRef(false);
  const showSummaryRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (step === 'done' && result && !builtOnce.current) {
      builtOnce.current = true;
      showSummaryRef.current();
    }
  }, [step, result]);

  /* Shrink the preview paper to the ticket's real height (receipt-preview
   * pattern) — a fixed box either clips a long statement or floats in space. */
  const fitPaper = useCallback(() => {
    const doc = paperRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = Math.ceil(doc.body.scrollHeight) + 2;
    if (h > 0) setPaperH(Math.min(PAPER_MAX_H, Math.max(PAPER_MIN_H, h)));
  }, []);

  /* Build the ticket once per statement so the "Printed" stamp on screen is the
   * one that goes on the paper. */
  const paper = useMemo(
    () => (statement
      ? { text: buildClosingStatementText(statement), html: buildClosingStatementHtml(statement) }
      : null),
    [statement],
  );

  const printSummary = useCallback(async () => {
    if (!paper || !sessionId) return;
    setPrinting(true);
    try {
      const r = await api.post<{ ok: boolean; backend: string; message?: string }>(
        '/pos/receipts/print-closing-statement',
        { sessionId, text: paper.text },
      );
      if (r.data.ok) {
        setPrinted(true);
        toast.success(r.data.backend === 'console' ? r.data.message ?? 'Logged (no printer)' : 'Closing summary sent to printer');
      } else {
        toast.warning(r.data.message ?? 'Printer error');
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Print failed');
    } finally {
      setPrinting(false);
    }
  }, [paper, sessionId]);

  /* Closing the dialog ends that run. The component stays mounted between
   * shifts, so anything left behind — the finished done step, its figures, the
   * summary paper, a typed count, a manager's PIN — would be presented as
   * belonging to the NEXT shift being closed. Wipe it on the way out. */
  useEffect(() => {
    if (open) return;
    setStep('check');
    setResult(null);
    setProblem(null);
    setCounted('');
    setNotes('');
    setVarianceReason('');
    setByDenom(false);
    setDenom({});
    setShowManager(false);
    setApproverEmail('');
    setManagerPin('');
    setStatement(null);
    setPrinted(false);
    setPrinting(false);
    setPaperH(PAPER_MIN_H);
    builtOnce.current = false;
  }, [open]);

  if (!session) return null;

  const submit = async () => {
    setProblem(null);
    if (!countedValid) {
      setProblem({
        tone: 'error',
        title: 'We still need the counted amount',
        detail: 'Enter the cash in the drawer, or switch to counting note by note.',
        goTo: 'count',
      });
      setStep('count');
      return;
    }
    // Every tracked wallet/bank account needs a closing observation, or an
    // explicit "not counted" with a reason — the server refuses silence.
    const effectiveCounts: Record<string, number> = { ...accountCounts };
    for (const row of accountRows) {
      if (!(row.accountId in effectiveCounts) && row.expected === 0) effectiveCounts[row.accountId] = 0;
    }
    if (Object.keys(effectiveCounts).length !== Object.keys(accountCounts).length) setAccountCounts(effectiveCounts);
    const unchecked = accountRows.filter((row) => !(row.accountId in effectiveCounts) && !(uncounted[row.accountId] ?? '').trim());
    if (unchecked.length) {
      setProblem({
        tone: 'error',
        title: 'Check every wallet and bank account',
        detail: `Enter what the provider shows for ${unchecked.map((r) => r.label).join(', ')}, or mark it "not counted" and say why.`,
        goTo: 'confirm',
      });
      setStep('confirm');
      return;
    }
    const uncountedAccounts = Object.fromEntries(Object.entries(uncounted).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const needsManager = showManager || Object.keys(uncountedAccounts).length > 0;
    if (Object.keys(uncountedAccounts).length > 0 && (!approverEmail.trim() || !managerPin.trim())) {
      setShowManager(true);
      setProblem({
        tone: 'error',
        title: 'A manager must approve uncounted accounts',
        detail: 'Ask a manager to enter their email and PIN below.',
        goTo: 'confirm',
      });
      setStep('confirm');
      return;
    }
    const closingDenomination = byDenom
      ? Object.fromEntries(
          DENOMS.map((f) => [String(f), parseInt(denom[f] || '0', 10) || 0]).filter(([, c]) => (c as number) > 0),
        )
      : undefined;
    try {
      const res = await closeShift.mutateAsync({
        closingCounted: countedNum,
        notes: notes.trim() || undefined,
        varianceReason: varianceReason.trim() || undefined,
        autoAdjustCash: autoAdjustCash && cashVariance != null && Math.abs(cashVariance) > 0.005 ? true : undefined,
        approverEmail: needsManager ? approverEmail.trim() || undefined : undefined,
        managerPin: needsManager ? managerPin.trim() || undefined : undefined,
        closingDenomination,
        // Only accounts the cashier actually confirmed; the server treats an
        // absent account as unchecked rather than as a zero balance.
        closingAccounts: Object.keys(effectiveCounts).length ? effectiveCounts : undefined,
        uncountedAccounts: Object.keys(uncountedAccounts).length ? uncountedAccounts : undefined,
        sessionId: session.id,
      });
      setResult(res as CashSession);
      setStep('done');
      toast.success('Shift closed');
    } catch (e: any) {
      const decoded = decodeError(e?.response?.data ?? e?.message);
      setProblem(decoded);
      if (decoded.revealManager) setShowManager(true);
      if (decoded.goTo === 'check') { void recheck(); void refreshDeviceOps(); }
      if (decoded.goTo) setStep(decoded.goTo);
    }
  };

  const finish = () => {
    onClosed();
    onClose();
  };

  /* Small receipt-size closing statement: opening float, total sales and the
   * sales breakdown per payment mode — previewed on the done step as soon as
   * the shift closes; printed only when the cashier asks. */
  const showSummary = () => {
    const report: any = recon?.report ?? {};
    setStatement({
      openingFloat: session.openingFloat,
      openedAt: session.openedAt,
      closedAt: (result as any)?.closedAt ?? new Date().toISOString(),
      registerName: session.cashRegister?.name ?? report.cashSession?.registerName,
      cashierName: report.cashSession?.cashierName ?? null,
      totals: report.totals,
      byMethod: report.byMethod,
      counted: (result as any)?.closingCounted,
      expected: (result as any)?.closingExpected,
      difference: (result as any)?.closingDifference,
    });
  };
  showSummaryRef.current = showSummary;

  const variance = Number(result?.closingDifference ?? 0);
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  /* Live drawer difference on the confirm step (display only — the server
   * recomputes authoritatively at close time). */
  const expectedCash = recon ? Number(recon.report?.totals?.expectedCash ?? 0) : null;
  const cashVariance = expectedCash != null && countedValid ? countedNum - expectedCash : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && (step === 'done' ? finish() : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1000px,96vw)]">
        <DialogHeader className="border-b border-slate-100 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <PowerOff className="h-4 w-4 text-rose-600" />
            {step === 'done' ? 'Shift closed' : 'Close shift'}
          </DialogTitle>
          <DialogDescription>
            {step === 'check' && 'First, a quick look for anything still open on this shift.'}
            {step === 'count' && 'Count the cash in the drawer and enter what you find.'}
            {step === 'confirm' && 'Last look before the drawer is sealed for the day.'}
            {step === 'done' && 'The drawer is sealed and the Z-report is stored.'}
          </DialogDescription>

          {/* Step rail */}
          {step !== 'done' ? (
            <div className="mt-3 flex items-center gap-2">
              {STEPS.map((s, i) => (
                <React.Fragment key={s.key}>
                  <span
                    className={
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ' +
                      (i < stepIndex
                        ? 'bg-emerald-50 text-emerald-700'
                        : i === stepIndex
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-400')
                    }
                  >
                    {i < stepIndex ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-slate-200" /> : null}
                </React.Fragment>
              ))}
            </div>
          ) : null}
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {/* Shift facts — always visible so the cashier knows what they are sealing */}
          {step !== 'done' ? (
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Opening float</p>
                <p className="font-mono text-sm font-bold text-slate-900">{fmt(session.openingFloat)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Sales this shift</p>
                <p className="font-mono text-sm font-bold text-slate-900">
                  {recon ? fmt(recon.report?.totals?.salesTotal) : '—'}
                </p>
                {recon ? (
                  <p className="text-[10px] text-slate-500">
                    {plain(recon.report?.totals?.saleCount)} sale{Number(recon.report?.totals?.saleCount) === 1 ? '' : 's'} · all payment methods
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Open since</p>
                <p className="text-sm font-bold text-slate-900">
                  {session.openedAt ? new Date(session.openedAt).toLocaleTimeString() : '—'}
                </p>
              </div>
            </div>
          ) : null}

          {/* Anything the server told us, in plain words */}
          {problem ? (
            <Notice tone={problem.tone} title={problem.title}>
              <p>{problem.detail}</p>
            </Notice>
          ) : null}

          {/* ---------------------------------------------------------- check */}
          {step === 'check' ? (
            <>
              {/* Closing amounts — shown up front so the cashier can see what the
                  shift should finish with before anything is sealed. The drawer
                  expected figure is exposed here by design, so the count is a
                  verification against a known target rather than a blind guess. */}
              {recon ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    Closing amounts
                  </p>
                  <div className="mt-1.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-700">Cash (drawer)</span>
                      <span className="font-mono text-sm font-bold tabular-nums text-slate-900">
                        {fmt(recon.report?.totals?.expectedCash)}
                      </span>
                    </div>
                    {accountRows.map((row) => (
                      <div key={row.accountId} className="flex items-center justify-between">
                        <span className="truncate text-sm text-slate-700">{row.label}</span>
                        <span className="font-mono text-sm font-bold tabular-nums text-slate-900">
                          {fmt(row.expected)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Device-local payments bound to this shift — informational
                  only: they sync under any sign-in and never block closing. */}
              {deviceOps.length ? (
                <Notice tone="warn" title={`${deviceOps.length} payment${deviceOps.length === 1 ? '' : 's'} on this device still need${deviceOps.length === 1 ? 's' : ''} syncing`}>
                  <p>
                    These were taken at the till but not confirmed by the server. They sync under any sign-in —
                    a payment the server already recorded clears itself. This does not stop you closing the shift;
                    anything still queued keeps syncing after the shift is sealed.
                  </p>
                  <ul className="mt-2 space-y-2">
                    {deviceOps.map((op) => (
                      <DeviceOpRow
                        key={op.idempotencyKey}
                        op={op}
                        busy={busyOp === op.idempotencyKey}
                        confirmingDiscard={confirmDiscard === op.idempotencyKey}
                        onStartDiscard={() => setConfirmDiscard(op.idempotencyKey)}
                        onCancelDiscard={() => setConfirmDiscard(null)}
                        onSync={() => void syncOne(op as QueuedSale)}
                        onRetry={() => void retryOne(op as FailedSale)}
                        onDiscard={() => void discardOne(op as FailedSale)}
                      />
                    ))}
                  </ul>
                </Notice>
              ) : null}

              {!recon ? (
                <Notice tone="info" title="Checking this shift...">
                  <p>Looking for open orders, unpaid sales and stock still posting.</p>
                </Notice>
              ) : ready ? (
                <Notice tone="ok" title="All clear — nothing is left open">
                  <p>Every order is settled and the books agree with the drawer. You can count now.</p>
                </Notice>
              ) : (
                <Notice tone="warn" title={`${problemCount} thing${problemCount === 1 ? '' : 's'} to sort out first`}>
                  <ul className="space-y-2">
                    {blockers.map((b) => (
                      <li key={b.text}>
                        <span className="font-semibold">{b.text}</span>
                        <br />
                        <span className="opacity-80">{b.hint}</span>
                        {b.items?.length ? (
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] opacity-70">
                            {b.items.slice(0, b.count ? 50 : 4).map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                            {!b.count && b.items.length > 4 ? <li>and {b.items.length - 4} more like this</li> : null}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}

              {recon?.pendingPostings ? (
                <Notice tone="info" title={`${recon.pendingPostings} stock deduction${recon.pendingPostings === 1 ? '' : 's'} still posting`}>
                  <p>
                    This does not stop you closing — your sales and money are final. Stock catches up on its own;
                    anything that cannot post shows on the Posting Monitor for a manager.
                  </p>
                </Notice>
              ) : null}

              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 disabled:opacity-50"
                onClick={() => recheck()}
                disabled={checking}
              >
                {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </>
          ) : null}

          {/* ---------------------------------------------------------- count */}
          {step === 'count' ? (
            <>
              <Notice tone="info" title="Count to the expected figures">
                <p>
                  The expected closing amounts were shown on the previous screen. Count what is actually
                  there and enter it — the difference is shown when you confirm.
                </p>
              </Notice>

              <div className="flex items-center justify-between">
                <Label className="text-sm font-bold">Cash in the drawer ({orgCur()})</Label>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-900"
                  onClick={() => setByDenom((v) => !v)}
                >
                  <Calculator className="h-3 w-3" /> {byDenom ? 'Type one total instead' : 'Count note by note'}
                </button>
              </div>

              {byDenom ? (
                <div className="space-y-1.5">
                  {DENOMS.map((face) => {
                    const count = parseInt(denom[face] || '0', 10) || 0;
                    return (
                      <div key={face} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-right font-mono text-xs font-bold text-slate-500">
                          {face.toLocaleString()}
                        </span>
                        <span className="text-slate-300">×</span>
                        <Input
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={denom[face] ?? ''}
                          onChange={(e) => setDenom((d) => ({ ...d, [face]: e.target.value }))}
                          placeholder="0"
                          className="h-9 w-24 text-right font-mono"
                        />
                        <span className="flex-1 text-right font-mono text-sm tabular-nums text-slate-500">
                          {count > 0 ? plain(face * count) : <span className="text-slate-300">—</span>}
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between rounded-lg bg-slate-900 px-3 py-2.5 text-white">
                    <span className="text-sm font-semibold">
                      Counted total
                      <span className="ml-2 text-xs font-normal opacity-70">
                        {denomPieces} note{denomPieces === 1 ? '' : 's'}/coin{denomPieces === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="font-mono text-lg font-extrabold tabular-nums">{fmt(denomTotal)}</span>
                  </div>
                  {denomPieces > 0 ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-rose-600"
                      onClick={() => setDenom({})}
                    >
                      <Trash2 className="h-3 w-3" /> Start the count over
                    </button>
                  ) : null}
                </div>
              ) : (
                <div>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={counted}
                    onChange={(e) => setCounted(e.target.value)}
                    placeholder="0"
                    className="h-14 text-right font-mono text-2xl font-bold"
                    autoFocus
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Everything in the drawer, including the opening float.
                  </p>
                </div>
              )}
            </>
          ) : null}

          {/* -------------------------------------------------------- confirm */}
          {step === 'confirm' ? (
            <>
              <div className="flex items-center justify-between rounded-lg border-2 border-slate-900 px-4 py-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">You counted</p>
                  <p className="text-xs text-slate-500">
                    {byDenom ? `${denomPieces} notes/coins` : 'Entered as one total'}
                  </p>
                </div>
                <span className="font-mono text-2xl font-extrabold tabular-nums">{fmt(countedNum)}</span>
              </div>

              {/* Wallet and bank accounts: what the POS took in, and — optionally —
                  what the provider says it holds. Unlike the drawer these are not
                  blind: the same expected figure is on the Cash Register page. */}
              {accountRows.length ? (
                <div className="rounded-lg border border-slate-200 overflow-x-auto">
                  <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Wallet and bank accounts
                  </p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="px-3 py-1 text-left font-bold">Account</th>
                        <th className="px-2 py-1 text-right font-bold">Opening</th>
                        <th className="px-2 py-1 text-right font-bold">Received</th>
                        <th className="px-2 py-1 text-right font-bold">Refunds</th>
                        <th className="px-2 py-1 text-right font-bold">Expected</th>
                        <th className="px-2 py-1 text-right font-bold">Provider shows</th>
                        <th className="px-3 py-1 text-right font-bold">Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountRows.map((row) => (
                        <tr key={row.accountId} className="border-t border-slate-100">
                          <td
                            className="whitespace-nowrap px-3 py-1 font-semibold text-slate-700"
                            title={row.openingKnown ? undefined : 'No opening balance recorded'}
                          >
                            {row.accountName || row.label}
                          </td>
                          <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-500">{plain(row.opening)}</td>
                          <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-700">{plain(row.received)}</td>
                          <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-500">{plain(row.refunds)}</td>
                          <td
                            className="px-2 py-1 text-right font-mono tabular-nums font-bold text-slate-900"
                            title={`Opening ${plain(row.opening)} + received ${plain(row.received)} − refunds ${plain(row.refunds)}${row.otherMovements ? ` ${row.otherMovements > 0 ? '+' : '−'} settlements/transfers ${plain(Math.abs(row.otherMovements))}` : ''}`}
                          >
                            {plain(row.expected)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {row.accountId in uncounted ? (
                              <div className="flex items-center justify-end gap-2">
                                <input
                                  aria-label={`Why ${row.label} was not counted`}
                                  className="w-36 rounded border border-amber-300 bg-amber-50 p-1 text-xs"
                                  placeholder="Why not counted?"
                                  value={uncounted[row.accountId]}
                                  onChange={(e) => setUncounted((u) => ({ ...u, [row.accountId]: e.target.value }))}
                                />
                                <button
                                  type="button"
                                  className="whitespace-nowrap text-[10px] font-semibold text-slate-500 hover:text-slate-900"
                                  onClick={() => setUncounted((u) => { const next = { ...u }; delete next[row.accountId]; return next; })}
                                >
                                  Enter balance instead
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <input
                                  aria-label={`Closing balance ${row.label}`}
                                  type="number"
                                  min="0"
                                  step="any"
                                  placeholder="—"
                                  className="w-28 rounded border border-slate-200 p-1 text-right font-mono text-xs"
                                  value={accountCounts[row.accountId] ?? ''}
                                  onChange={(e) => {
                                    const next = { ...accountCounts };
                                    if (e.target.value === '') delete next[row.accountId];
                                    else next[row.accountId] = Number(e.target.value);
                                    setAccountCounts(next);
                                  }}
                                />
                                <button
                                  type="button"
                                  className="whitespace-nowrap text-[10px] font-semibold text-slate-500 hover:text-slate-900"
                                  onClick={() => {
                                    setAccountCounts((c) => { const next = { ...c }; delete next[row.accountId]; return next; });
                                    setUncounted((u) => ({ ...u, [row.accountId]: '' }));
                                    setShowManager(true);
                                  }}
                                >
                                  Could not check
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-1 text-right font-mono tabular-nums font-bold">
                            {row.variance == null ? (
                              <span className="text-slate-300">—</span>
                            ) : Math.abs(row.variance) < 0.005 ? (
                              <span className="text-emerald-600">0 ✓</span>
                            ) : (
                              <span className="text-rose-600">{row.variance > 0 ? '+' : ''}{plain(row.variance)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="px-3 py-1 text-[11px] text-slate-500">
                    Enter what each provider shows. If you cannot check an account, choose "Could not check",
                    give the reason and get a manager to approve. Money still sitting with a provider is swept
                    to the bank separately, under Money &amp; Accounts → Settlements.
                  </p>
                </div>
              ) : null}

              {cashVariance != null && Math.abs(cashVariance) > 0.005 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-amber-700">Drawer difference</p>
                  <p className="mt-1 text-sm text-amber-900">
                    You counted <span className="font-mono font-bold">{fmt(countedNum)}</span> —{' '}
                    {cashVariance < 0
                      ? <>{orgCur()} {plain(Math.abs(cashVariance))} <b>short</b>. If accepted, this is recorded as a <b>withdrawal</b>.</>
                      : <>{orgCur()} {plain(cashVariance)} <b>over</b>. If accepted, this is recorded as a <b>cash-in</b>.</>}
                  </p>
                  <label className="mt-2 flex items-start gap-2 text-sm font-semibold text-amber-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoAdjustCash}
                      onChange={(e) => setAutoAdjustCash(e.target.checked)}
                      className="mt-0.5"
                    />
                    Accept — record the difference automatically and close without a variance review
                  </label>
                  {!autoAdjustCash ? (
                    <p className="mt-1 text-xs text-amber-800">
                      Without accepting, write below why the drawer does not balance (a manager is asked for a big difference).
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div>
                <Label className="text-sm font-bold">
                  {autoAdjustCash && cashVariance != null && Math.abs(cashVariance) > 0.005
                    ? 'Anything else worth noting?'
                    : 'If the drawer or a wallet doesn\u2019t balance, why?'}{' '}
                  <span className="font-normal text-slate-400">(only needed if it does not balance)</span>
                </Label>
                <Textarea
                  ref={reasonRef}
                  rows={2}
                  value={varianceReason}
                  onChange={(e) => setVarianceReason(e.target.value)}
                  placeholder={`e.g. ${orgCur()} 5,000 short — gave wrong change on table 4`}
                  className="mt-1 resize-none"
                />
              </div>

              <div>
                <Label className="text-sm font-bold">
                  Anything else worth noting? <span className="font-normal text-slate-400">(optional)</span>
                </Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={`e.g. Took ${orgCur()} 20,000 for the bread run`}
                  className="mt-1"
                />
              </div>

              <div className="rounded-lg border border-slate-200 p-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold text-slate-600 hover:text-slate-900"
                  onClick={() => setShowManager((v) => !v)}
                >
                  <ShieldCheck className="h-4 w-4 text-slate-400" />
                  Manager sign-off
                  <span className="ml-auto text-xs font-normal text-slate-400">
                    {showManager ? 'Hide' : 'For a big difference or an unchecked account'}
                  </span>
                </button>
                {showManager ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-slate-500">
                      A manager (not you) enters their own login below. We ask when the cash difference is large,
                      when a wallet/bank balance differs, or when an account could not be checked.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        value={approverEmail}
                        onChange={(e) => setApproverEmail(e.target.value)}
                        placeholder="Manager email"
                        autoComplete="off"
                      />
                      <Input
                        type="password"
                        value={managerPin}
                        onChange={(e) => setManagerPin(e.target.value)}
                        placeholder="Manager PIN"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {/* ----------------------------------------------------------- done */}
          {step === 'done' && result ? (
            <>
              <div
                className={
                  'rounded-xl border-2 p-4 text-center ' +
                  (variance === 0
                    ? 'border-emerald-300 bg-emerald-50'
                    : variance > 0
                      ? 'border-blue-300 bg-blue-50'
                      : 'border-rose-300 bg-rose-50')
                }
              >
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  {variance === 0 ? 'The drawer balanced' : variance > 0 ? 'Drawer was over' : 'Drawer was short'}
                </p>
                <p
                  className={
                    'mt-1 font-mono text-3xl font-extrabold ' +
                    (variance === 0 ? 'text-emerald-700' : variance > 0 ? 'text-blue-700' : 'text-rose-700')
                  }
                >
                  {variance > 0 ? '+' : ''}
                  {fmt(variance)}
                </p>
              </div>

              <div className="space-y-1 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">You counted</span>
                  <span className="font-mono font-bold">{fmt(result.closingCounted)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">System expected</span>
                  <span className="font-mono font-bold">{fmt(result.closingExpected)}</span>
                </div>
              </div>

              {result.varianceStatus === 'pending_review' ? (
                <Notice tone="warn" title="A manager will review this difference">
                  <p>Nothing more for you to do — the shift is closed and flagged for review.</p>
                </Notice>
              ) : null}
              {variance === 0 ? (
                <Notice tone="ok" title="Nice count">
                  <p>Cash on hand matched the books exactly.</p>
                </Notice>
              ) : null}

              {/* Closing summary — shown, not printed. The cashier decides. */}
              {paper ? (
                <div className="rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
                    <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
                      <Printer className="h-4 w-4 text-slate-500" /> Print the closing summary?
                    </p>
                    <div className="flex items-center gap-2">
                      {printed ? (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-emerald-600">Printed</span>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={printSummary}
                        disabled={printing}
                        style={{ background: '#16a34a' }}
                      >
                        <Printer className="mr-1 h-4 w-4" />
                        {printing ? 'Sending…' : printed ? 'Print again' : 'Print summary'}
                      </Button>
                    </div>
                  </div>
                  <div className="flex justify-center bg-slate-200 p-4">
                    <iframe
                      ref={paperRef}
                      srcDoc={paper.html}
                      title="Closing summary preview"
                      className="bg-white shadow-md"
                      style={{ width: 340, height: paperH }}
                      onLoad={fitPaper}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {/* ---------------------------------------------------------- footer */}
        <DialogFooter className="border-t border-slate-100 px-6 py-4">
          {step === 'check' ? (
            <>
              <Button variant="ghost" onClick={onClose}>Not yet</Button>
              <Button onClick={() => { setProblem(null); setStep('count'); }} disabled={!ready}>
                Count the drawer <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          ) : null}

          {step === 'count' ? (
            <>
              <Button variant="ghost" onClick={() => setStep('check')}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
              <Button onClick={() => { setProblem(null); setStep('confirm'); }} disabled={!countedValid}>
                Review <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          ) : null}

          {step === 'confirm' ? (
            <>
              <Button variant="ghost" onClick={() => setStep('count')}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Change the count
              </Button>
              <Button onClick={submit} disabled={closeShift.isPending} style={{ background: '#dc2626' }}>
                {closeShift.isPending ? (
                  <><Loader2 className="mr-1 h-4 w-4 animate-spin" /> Closing…</>
                ) : (
                  'Close shift'
                )}
              </Button>
            </>
          ) : null}

          {step === 'done' ? (
            <>
              {/* The summary builds itself on this step; this is the retry path
                  for the rare case where it did not. */}
              {!paper ? (
                <Button variant="ghost" onClick={showSummary}>
                  <Printer className="mr-1 h-4 w-4" /> Closing summary
                </Button>
              ) : null}
              <Button onClick={finish}>{printed ? 'Done' : 'Done — skip printing'}</Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
