import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, BriefcaseBusiness, ChevronLeft, ChevronRight, CircleDashed, CreditCard,
  HandCoins, Landmark, Receipt, RotateCcw, ScrollText, ShoppingBag, Smartphone, SlidersHorizontal,
  Truck, Users, Vault, Wallet, KeyRound, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { money, useOrgCurrency } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import { PERMISSIONS } from '@erp/shared';
import { Button } from '@/components/ui/button';

// ───────────────────────────── Amounts ─────────────────────────────

/** Formats an amount with an explicit currency code; never guesses one. */
export function formatAmount(value: string | number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const digits = Number.isInteger(n) ? 0 : 2;
  const num = new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(Math.abs(n));
  return `${n < 0 ? '−' : ''}${currency ? `${currency} ` : ''}${num}`;
}

/** Currency for an amount: the amount's own code → org base currency → none. */
export function useAmountCurrency(code?: string | null): string | null {
  const org = useOrgCurrency();
  return code || org || null;
}

export function MoneyAmount({
  value, currency, sign, className, muted,
}: {
  value: string | number | null | undefined;
  currency?: string | null;
  /** `in` prefixes "+", `out` prefixes "−"; omit to show the value as-is. */
  sign?: 'in' | 'out' | 'none';
  className?: string;
  muted?: boolean;
}) {
  const code = useAmountCurrency(currency);
  const n = Math.abs(Number(value ?? 0));
  const prefix = sign === 'in' ? '+ ' : sign === 'out' ? '− ' : '';
  const text = sign && sign !== 'none' ? `${prefix}${formatAmount(n, code)}` : formatAmount(value, code);
  return (
    <span className={cn('tabular-nums whitespace-nowrap', muted && 'text-muted-foreground', className)}>
      {text}
      {!code ? <span className="ml-1 text-[10px] font-normal text-amber-700">(currency unavailable)</span> : null}
    </span>
  );
}

export { money };

// ───────────────────────────── Organisation calendar ─────────────────────────────

/** The organisation's IANA time zone; falls back to the browser's. */
export function useOrgTimezone(): string {
  const tz = useAuthStore((st) => st.organization?.timezone);
  return validTimezone(tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validTimezone(tz?: string | null): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return null; }
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function ymdInZone(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Add whole days to a YYYY-MM-DD date (calendar arithmetic, no time zone). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Today in the organisation's calendar. "Today" everywhere in Money & Accounts
 * means this date, so a 01:30 Kampala sale is today's sale in Kampala even when
 * the browser or the server clock is on UTC.
 */
export function useOrgToday(): string {
  return ymdInZone(useOrgTimezone());
}

// ───────────────────────────── Account types ─────────────────────────────

const ACCOUNT_TYPE_META: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  drawers: { label: 'Register drawers', icon: Banknote, tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  cash: { label: 'Cash & safe', icon: Vault, tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  bank: { label: 'Bank', icon: Landmark, tone: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  mobile_money: { label: 'Mobile money', icon: Smartphone, tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  petty_cash: { label: 'Petty cash', icon: Wallet, tone: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  current_asset: { label: 'Card clearing', icon: CreditCard, tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
};

export const accountTypeLabel = (key?: string | null) => ACCOUNT_TYPE_META[key ?? '']?.label ?? (key ? key.replace(/_/g, ' ') : 'Other');

export function AccountTypeIcon({ type, className }: { type?: string | null; className?: string }) {
  const meta = ACCOUNT_TYPE_META[type ?? ''] ?? { icon: Wallet, tone: 'bg-muted text-muted-foreground' };
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', meta.tone, className)} aria-hidden>
      <Icon className="h-4 w-4" />
    </span>
  );
}

// ───────────────────────────── Categories & direction ─────────────────────────────

const CATEGORY_ICON: Record<string, LucideIcon> = {
  pos_sales: ShoppingBag,
  customer_receipts: HandCoins,
  refunds: RotateCcw,
  supplier_payments: Truck,
  expenses: Receipt,
  payroll: Users,
  transfers: ArrowLeftRight,
  deposits: ArrowDownLeft,
  withdrawals: ArrowUpRight,
  cash_drawer: Banknote,
  tender_settlement: Landmark,
  rental: KeyRound,
  adjustments: SlidersHorizontal,
  other: CircleDashed,
};

export function CategoryBadge({ category, label }: { category: string; label: string }) {
  const Icon = CATEGORY_ICON[category] ?? ScrollText;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      {label}
    </span>
  );
}

export const DIRECTION_META: Record<string, { label: string; className: string; icon: LucideIcon }> = {
  in: { label: 'Money in', className: 'text-emerald-700 dark:text-emerald-400', icon: ArrowDownLeft },
  out: { label: 'Money out', className: 'text-rose-700 dark:text-rose-400', icon: ArrowUpRight },
  internal: { label: 'Moved between accounts', className: 'text-sky-700 dark:text-sky-400', icon: ArrowLeftRight },
  adjustment: { label: 'Adjustment', className: 'text-amber-700 dark:text-amber-400', icon: SlidersHorizontal },
};

export function DirectionLabel({ direction }: { direction: string }) {
  const meta = DIRECTION_META[direction] ?? DIRECTION_META.adjustment;
  const Icon = meta.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', meta.className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden /> {meta.label}
    </span>
  );
}

// ───────────────────────────── Layout ─────────────────────────────

export function StatCard({
  label, value, hint, icon: Icon, onClick, tone = 'default', children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  onClick?: () => void;
  tone?: 'default' | 'primary';
  children?: ReactNode;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-h-[44px] w-full flex-col gap-1 rounded-xl border bg-card p-4 text-left shadow-sm transition-colors',
        onClick && 'hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tone === 'primary' && 'border-primary/30 bg-primary/5',
      )}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
        {label}
      </span>
      <span className="text-lg font-semibold text-foreground">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {children}
    </Comp>
  );
}

export function MoneyPageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const SECTION_TABS = [
  { to: '/accounts/cash-accounts', label: 'Overview', end: true, permission: PERMISSIONS.account.read },
  { to: '/accounts/cash-accounts/accounts', label: 'Accounts', end: false, permission: PERMISSIONS.account.read },
  { to: '/accounts/cash-accounts/activity', label: 'Activity', end: false, permission: PERMISSIONS.account.read },
  { to: '/accounts/cash-accounts/settlements', label: 'Settlements', end: false, permission: PERMISSIONS.cashSession.reconcile },
];

/** Routed section navigation: real links (history, reload, deep links), styled as tabs. */
export function MoneySectionNav() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  return (
    <nav aria-label="Money & Accounts sections" className="-mx-1 overflow-x-auto">
      <div className="flex min-w-max gap-1 border-b px-1">
        {SECTION_TABS.filter((t) => hasPermission(t.permission)).map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => cn(
              'inline-flex min-h-[44px] items-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function MoneyPage({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
      <MoneyPageHeader title={title} description={description} actions={actions} />
      <MoneySectionNav />
      {children}
    </div>
  );
}

/** A load failure with a way out — never an empty list or an endless spinner. */
export function LoadError({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {message}
      </span>
      <Button variant="outline" className="min-h-[44px] self-start sm:self-auto" onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Try again'}
      </Button>
    </div>
  );
}

export function Pager({ page, totalPages, onChange, summary }: { page: number; totalPages: number; onChange: (p: number) => void; summary?: ReactNode }) {
  return (
    <nav aria-label="Pagination" className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-muted-foreground">{summary ?? `Page ${page} of ${totalPages}`}</span>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button variant="outline" className="min-h-[44px]" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft className="mr-1 h-4 w-4" aria-hidden /> Previous</Button>
        <Button variant="outline" className="min-h-[44px]" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" aria-hidden /></Button>
      </div>
    </nav>
  );
}

export function EmptyState({ icon: Icon = BriefcaseBusiness, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card p-10 text-center">
      <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="font-medium text-foreground">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}
