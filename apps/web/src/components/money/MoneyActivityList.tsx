import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { MoneyActivity } from '@/features/money/api';
import { cn } from '@/lib/utils';
import { CategoryBadge, DirectionLabel, MoneyAmount, useOrgTimezone } from './money-ui';

/** Where the source document behind an activity lives, when the app has a page for it. */
export function sourceHref(a: Pick<MoneyActivity, 'sourceType' | 'sourceId' | 'register' | 'journalEntryId'>): { href: string; label: string } | null {
  const id = a.sourceId;
  switch (a.sourceType) {
    case 'pos':
    case 'pos_invoice':
    case 'pos_invoice_extra':
    case 'pos_refund':
      return id ? { href: `/pos/receipts/${id}`, label: 'Open receipt' } : null;
    case 'payment':
      return id ? { href: `/payments/${id}`, label: 'Open receipt' } : null;
    case 'invoice':
    case 'sales_invoice':
      return id ? { href: `/invoices/${id}`, label: 'Open invoice' } : null;
    case 'credit_note':
      return id ? { href: `/credit-notes/${id}`, label: 'Open credit note' } : null;
    case 'purchase_payment':
    case 'vendor_bill':
      return { href: '/supplier-payments', label: 'Supplier payments' };
    case 'expense_payment':
      return { href: '/expenses', label: 'Expenses' };
    case 'tender_settlement':
      return { href: '/accounts/cash-accounts/settlements', label: 'Settlements' };
    default:
      if (a.register) return { href: '/pos/cash-registers?tab=history', label: 'Register history' };
      return null;
  }
}

/** Date and time in the organisation's calendar, so rows agree with "Today". */
const time = (iso: string, timeZone: string) => {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone }),
  };
};

function amountFor(a: MoneyActivity) {
  if (a.direction === 'in') return { value: a.externalIn, sign: 'in' as const };
  if (a.direction === 'out') return { value: a.externalOut, sign: 'out' as const };
  if (a.direction === 'internal') return { value: a.grossAmount, sign: 'none' as const };
  const net = Number(a.externalIn) - Number(a.externalOut);
  return { value: Math.abs(net) || a.grossAmount, sign: net > 0 ? 'in' as const : net < 0 ? 'out' as const : 'none' as const };
}

function amountTone(a: MoneyActivity) {
  return cn('font-semibold',
    a.status === 'reversed' && 'line-through',
    a.direction === 'in' && 'text-emerald-700 dark:text-emerald-400',
    a.direction === 'out' && 'text-rose-700 dark:text-rose-400');
}

function legSummary(a: MoneyActivity) {
  const outs = a.legs.filter((l) => l.side === 'out');
  const ins = a.legs.filter((l) => l.side === 'in');
  if (outs.length && ins.length) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {outs.map((l) => l.accountName).join(', ')} <ArrowRight className="h-3 w-3" aria-label="to" /> {ins.map((l) => l.accountName).join(', ')}
      </span>
    );
  }
  const legs = ins.length ? ins : outs;
  if (legs.length === 1) return <span>{ins.length ? 'Into' : 'From'} {legs[0].accountName}</span>;
  return <span>{ins.length ? 'Into' : 'From'} {legs.length} accounts</span>;
}

/** What an activity moved, and where to trace it. Shared by the table row and the phone card. */
function ActivityDetails({ a }: { a: MoneyActivity }) {
  const src = sourceHref(a);
  const linkClass = 'inline-flex min-h-[44px] items-center gap-1 rounded-md font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0';
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Account movements</p>
        <ul className="divide-y divide-border/60 md:space-y-1 md:divide-y-0">
          {a.legs.map((l) => (
            <li key={l.accountId} className="flex items-center justify-between gap-4 py-2 text-sm md:py-0 md:text-xs">
              <Link to={`/accounts/cash-accounts/${l.accountId}`} className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline">{l.accountName}</Link>
              <MoneyAmount value={l.amount} currency={a.currencyCode} sign={l.side} />
            </li>
          ))}
        </ul>
        {Number(a.internalMoved) > 0 && (Number(a.externalIn) > 0 || Number(a.externalOut) > 0) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Moved between your accounts: <MoneyAmount value={a.internalMoved} currency={a.currencyCode} />.{' '}
            {Number(a.externalOut) > 0 ? <>Left the business (e.g. fees): <MoneyAmount value={a.externalOut} currency={a.currencyCode} />.</> : null}
            {Number(a.externalIn) > 0 ? <>Came into the business: <MoneyAmount value={a.externalIn} currency={a.currencyCode} />.</> : null}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 text-xs md:flex-col md:items-end md:gap-1">
        <span className="w-full text-muted-foreground md:w-auto">Entry {a.entryNumber}</span>
        {src ? (
          <Link to={src.href} className={linkClass}>
            {src.label} <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        ) : null}
        <Link to={`/journal-entries/${a.journalEntryId}`} className={linkClass}>
          Journal entry <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

export function MoneyActivityList({ rows, emptyText = 'No money activity for these filters.' }: { rows: MoneyActivity[]; emptyText?: string }) {
  const timeZone = useOrgTimezone();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (rows.length === 0) {
    return <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <>
      {/* Phones: one stacked card per activity, the whole card is the tap target. */}
      <ul className="divide-y rounded-xl border bg-card md:hidden" aria-label="Money activity">
        {rows.map((a) => {
          const isOpen = open.has(a.id);
          const t = time(a.occurredAt, timeZone);
          const amt = amountFor(a);
          const reversed = a.status === 'reversed';
          return (
            <li key={a.id} className={cn(reversed && 'text-muted-foreground')}>
              <button
                type="button"
                onClick={() => toggle(a.id)}
                aria-expanded={isOpen}
                className="flex min-h-[64px] w-full items-start gap-3 px-3 py-3 text-left active:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <CategoryBadge category={a.category} label={a.categoryLabel} />
                    {reversed ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">Reversed</span> : null}
                  </span>
                  <span className={cn('block truncate text-sm text-foreground', reversed && 'line-through')}>{a.description || a.entryNumber}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <span className="tabular-nums">{t.date} · {t.time}</span> · {legSummary(a)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <MoneyAmount value={amt.value} currency={a.currencyCode} sign={amt.sign} className={amountTone(a)} />
                  <DirectionLabel direction={a.direction} />
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none', isOpen && 'rotate-180')} aria-hidden />
                </span>
              </button>
              {isOpen ? (
                <div className="border-t bg-muted/30 px-3 py-3">
                  {a.register ? <p className="mb-2 text-xs text-muted-foreground">Register: {a.register.name}</p> : null}
                  <ActivityDetails a={a} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Tablets and up: scannable table. */}
      <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="w-12 px-1 py-2"><span className="sr-only">Details</span></th>
              <th className="px-2 py-2 font-medium">When</th>
              <th className="px-2 py-2 font-medium">What happened</th>
              <th className="px-2 py-2 font-medium">Accounts</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const isOpen = open.has(a.id);
              const t = time(a.occurredAt, timeZone);
              const amt = amountFor(a);
              const reversed = a.status === 'reversed';
              return (
                <Fragment key={a.id}>
                  <tr className={cn('border-b last:border-0 hover:bg-muted/40', reversed && 'text-muted-foreground', isOpen && 'border-b-0 bg-muted/30')}>
                    <td className="px-1 py-1 align-top">
                      <button
                        type="button"
                        onClick={() => toggle(a.id)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Hide details' : 'Show details'}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 align-top">
                      <div className="font-medium tabular-nums text-foreground">{t.time}</div>
                      <div className="text-xs text-muted-foreground">{t.date}</div>
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <CategoryBadge category={a.category} label={a.categoryLabel} />
                        {reversed ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium">Reversed</span> : null}
                      </div>
                      <div className={cn('mt-1 max-w-[340px] truncate text-xs text-muted-foreground', reversed && 'line-through')} title={a.description ?? undefined}>
                        {a.description || a.entryNumber}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 align-top text-xs text-foreground">
                      {legSummary(a)}
                      {a.register ? <div className="text-muted-foreground">Register: {a.register.name}</div> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right align-top">
                      <MoneyAmount value={amt.value} currency={a.currencyCode} sign={amt.sign} className={amountTone(a)} />
                      <div className="mt-0.5"><DirectionLabel direction={a.direction} /></div>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b bg-muted/30 last:border-0">
                      <td />
                      <td colSpan={4} className="px-2 pb-3 pt-1">
                        <ActivityDetails a={a} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
