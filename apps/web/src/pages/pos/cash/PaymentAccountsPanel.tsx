/**
 * Payment Accounts panel for the Cash Register page.
 *
 * Answers, in one table, the two questions asked at the drawer:
 *   1. "Which money buckets exist?" — every account from Accounting → Cash
 *      Accounts (cash, petty cash, bank, mobile money, card clearing).
 *   2. "Which of them can the POS actually receive into?" — the ✓ column. An
 *      account is POS-receivable when GET /pos/payment-accounts returns it,
 *      i.e. it is selectable as a tender when a receipt is registered in the
 *      POS selling interface.
 *
 * When a shift is open it also lays each account's shift figures side by side:
 * opening balance → received → refunded → expected, mirroring the Close Shift
 * reconciliation so the two screens never disagree.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Check, Minus, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useCashAccounts } from '@/features/accounting/api';
import { usePaymentAccounts } from '@/features/pos/payment-accounts';
import { useSessionReconciliation, type ReconAccount } from '@/features/pos/session-reconciliation';
import { useAuthStore } from '@/stores/auth.store';
import type { CashSession } from '../types';

const orgCur = () => useAuthStore.getState().organization?.currencyCode ?? 'IDR';
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const money = (v: unknown) => num(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

const TYPE_META: Record<string, { label: string; icon: string; dot: string }> = {
  cash: { label: 'Cash', icon: '💵', dot: 'bg-emerald-500' },
  petty_cash: { label: 'Petty Cash', icon: '🪙', dot: 'bg-purple-500' },
  bank: { label: 'Bank', icon: '🏦', dot: 'bg-blue-500' },
  mobile_money: { label: 'Mobile Money', icon: '📱', dot: 'bg-orange-500' },
  current_asset: { label: 'Card Clearing', icon: '💳', dot: 'bg-sky-500' },
};
const meta = (t: string) => TYPE_META[t] ?? { label: t, icon: '📄', dot: 'bg-slate-400' };

// Order the table the way money flows through a shift, not alphabetically.
const TYPE_ORDER = ['cash', 'petty_cash', 'mobile_money', 'bank', 'current_asset'];

/** Tender types a provider has to settle before the money is really yours. */
const SETTLES = new Set(['mobile_money', 'bank', 'current_asset']);

/* ------------------------------------------------------------------ tiles */

const Tile: React.FC<{
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'emerald' | 'blue';
  icon: React.ReactNode;
}> = ({ label, value, sub, tone = 'default', icon }) => {
  const tones: Record<string, string> = {
    default: 'border-slate-200 bg-white',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    blue: 'border-blue-200 bg-blue-50/60',
  };
  return (
    <div className={`rounded-xl border p-3 flex items-start gap-3 ${tones[tone]}`}>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-lg font-extrabold text-slate-900 tabular-nums truncate">{value}</p>
        {sub ? <p className="text-[11px] text-slate-500">{sub}</p> : null}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ panel */

interface Props {
  /** Open session for the selected register, or null when the register is closed. */
  session: CashSession | null;
  /** Selected register — used to spot which account is this drawer. */
  registerId: string;
}

export const PaymentAccountsPanel: React.FC<Props> = ({ session, registerId }) => {
  const { data: cashAccounts = [], isLoading } = useCashAccounts();
  const { data: posAccounts = [] } = usePaymentAccounts();
  const { data: recon } = useSessionReconciliation(session?.id);

  const posIds = React.useMemo(() => new Set(posAccounts.map((a) => a.id)), [posAccounts]);

  const reconByAccount = React.useMemo(() => {
    const map = new Map<string, ReconAccount>();
    for (const a of (recon?.accounts ?? []) as ReconAccount[]) map.set(a.accountId, a);
    return map;
  }, [recon]);

  // Stable identity: a fresh `?? {}` each render would rebuild `rows` every time.
  const openingAccounts = React.useMemo(
    () => (((session as any)?.openingAccounts ?? {}) as Record<string, number | string>),
    [session],
  );
  const totals = recon?.report?.totals;

  // The drawer account is the cash account bound to this register.
  const drawerAccountId = React.useMemo(
    () => (cashAccounts as any[]).find((a) => a.cashRegister?.id === registerId)?.id as string | undefined,
    [cashAccounts, registerId],
  );

  const rows = React.useMemo(() => {
    const list = [...(cashAccounts as any[])];
    list.sort((a, b) => {
      const ai = TYPE_ORDER.indexOf(a.accountType);
      const bi = TYPE_ORDER.indexOf(b.accountType);
      if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      // POS-receivable accounts float above the rest inside a type.
      const ap = posIds.has(a.id) ? 0 : 1;
      const bp = posIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return String(a.code).localeCompare(String(b.code));
    });
    return list.map((acc) => {
      const isDrawer = acc.id === drawerAccountId;
      const r = reconByAccount.get(acc.id);
      const opening = isDrawer ? num(session?.openingFloat) : num(openingAccounts[acc.id]);
      const openingKnown = isDrawer ? !!session : openingAccounts[acc.id] != null;
      const received = isDrawer && totals ? num(totals.cashCollected) : num(r?.receipts);
      const refunds = isDrawer && totals ? num(totals.cashRefunds) : num(r?.refunds);
      // The drawer's expected figure already folds in pay-ins/pay-outs/adjustments;
      // other accounts only move by receipts and refunds during a shift.
      const expected = isDrawer && totals ? num(totals.expectedCash) : opening + received - refunds;
      return {
        acc,
        isDrawer,
        inPos: posIds.has(acc.id),
        opening,
        openingKnown,
        received,
        refunds,
        expected,
        // Only provider-backed tenders are ever "awaiting settlement"; physical
        // cash settles itself the moment it lands in the drawer.
        pendingSettlement: SETTLES.has(acc.accountType) ? num(r?.pendingSettlement) : 0,
        touched: !!r || (isDrawer && !!session),
      };
    });
  }, [cashAccounts, posIds, reconByAccount, drawerAccountId, session, openingAccounts, totals]);

  const posCount = rows.filter((r) => r.inPos).length;
  const salesTotal = num(totals?.salesTotal);
  // Split the tender take from the payments themselves. Deriving non-cash as
  // (sales − cash collected) is wrong whenever the drawer holds cash from a
  // period the session's invoices do not cover — it can go negative or past 100%.
  const byMethod = (recon?.byMethod ?? []) as { method: string; total: string }[];
  const cashSales = byMethod.filter((m) => m.method === 'cash').reduce((s, m) => s + num(m.total), 0);
  const nonCashSales = byMethod.filter((m) => m.method !== 'cash').reduce((s, m) => s + num(m.total), 0);
  const tenderTotal = cashSales + nonCashSales;
  const pct = (part: number) => (tenderTotal > 0 ? `${Math.round((part / tenderTotal) * 100)}% of tenders taken` : '—');

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-700">
            Payment accounts &amp; shift balances
          </h3>
          <p className="text-xs text-slate-500">
            Every account from Accounting → Cash Accounts. A ✓ means the POS can receive into it when a receipt is
            registered at the selling screen.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
            {posCount} of {rows.length} accepted in POS
          </span>
          <Link
            to="/settings/payment-methods"
            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Payment methods
          </Link>
        </div>
      </div>

      {/* Shift summary tiles */}
      {session ? (
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label="Opening float"
            value={`${orgCur()} ${money(session.openingFloat)}`}
            sub={`Open since ${session.openedAt ? new Date(session.openedAt).toLocaleTimeString() : '—'}`}
            icon={<span className="text-lg leading-none">💵</span>}
          />
          <Tile
            label="Total sales"
            value={`${orgCur()} ${money(salesTotal)}`}
            sub={`${num(totals?.saleCount)} transactions · ${orgCur()} ${money(tenderTotal)} tendered`}
            icon={<span className="text-lg leading-none">🧾</span>}
          />
          <Tile
            label="Cash sales"
            value={`${orgCur()} ${money(cashSales)}`}
            sub={pct(cashSales)}
            tone="emerald"
            icon={<span className="text-lg leading-none">🟢</span>}
          />
          <Tile
            label="Non-cash sales"
            value={`${orgCur()} ${money(nonCashSales)}`}
            sub={pct(nonCashSales)}
            tone="blue"
            icon={<span className="text-lg leading-none">💳</span>}
          />
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-bold">Account</th>
              <th className="px-3 py-2 text-left font-bold">Type</th>
              <th
                className="px-3 py-2 text-center font-bold"
                title="Selectable as a tender in the POS selling interface"
              >
                POS receiving
              </th>
              <th className="px-3 py-2 text-right font-bold">Opening ({orgCur()})</th>
              <th className="px-3 py-2 text-right font-bold">Received ({orgCur()})</th>
              <th className="px-3 py-2 text-right font-bold">Refunds ({orgCur()})</th>
              <th className="px-3 py-2 text-right font-bold">Expected ({orgCur()})</th>
              <th className="px-3 py-2 text-right font-bold">Ledger balance</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  Loading accounts…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  No cash accounts yet. Create them under Accounting → Cash Accounts.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const m = meta(row.acc.accountType);
                return (
                  <tr
                    key={row.acc.id}
                    className={'border-b border-slate-100 last:border-0 ' + (row.isDrawer ? 'bg-emerald-50/40' : '')}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-base leading-none">{m.icon}</span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-800">{row.acc.name}</p>
                          <p className="font-mono text-[11px] text-slate-400">
                            {row.acc.code}
                            {row.isDrawer ? (
                              <span className="ml-1 font-sans font-bold text-emerald-700">· this drawer</span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} /> {m.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {row.inPos ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200"
                          title="Accepted: a cashier can settle a receipt into this account"
                        >
                          <Check className="h-3 w-3" /> Accepted
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500"
                          title="Not offered as a tender at the POS selling screen"
                        >
                          <Minus className="h-3 w-3" /> Not in POS
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {session ? (
                        row.openingKnown ? (
                          money(row.opening)
                        ) : (
                          <span className="text-slate-300">not recorded</span>
                        )
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-emerald-700">
                      {session && row.touched ? money(row.received) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-rose-600">
                      {session && row.touched && row.refunds > 0 ? (
                        `-${money(row.refunds)}`
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-slate-900">
                      {/* An account nobody opened and nobody took money into has no
                          expectation to state — "0" would read as a counted zero. */}
                      {session && (row.touched || row.openingKnown) ? (
                        money(row.expected)
                      ) : (
                        <span className="font-normal text-slate-300">no activity</span>
                      )}
                      {row.pendingSettlement > 0 ? (
                        <p className="font-sans text-[10px] font-normal text-amber-600">
                          {money(row.pendingSettlement)} awaiting settlement
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-500">
                      {money(row.acc.balance)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" /> Accepted = offered as a tender when a receipt is
          registered in the POS.
        </span>
        <span className="inline-flex items-center gap-1">
          <Info className="h-3 w-3" /> Expected = opening + received − refunds (the drawer row also folds in cash
          in/out).
        </span>
        {!session ? (
          <span className="inline-flex items-center gap-1 text-amber-700">
            <AlertTriangle className="h-3 w-3" /> Shift figures appear once this register is open.
          </span>
        ) : null}
      </div>
    </div>
  );
};

export default PaymentAccountsPanel;
