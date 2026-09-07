/**
 * One filter bar for every POS report tab.
 *
 * Before this existed each tab hand-rolled its own controls, and most of them
 * only wired up From/To — the waiter, cashier, tender and status filters the API
 * had always supported were passed as a hard-coded `undefined`, so the report
 * silently ignored them. Declaring the fields a tab supports here means a filter
 * either appears and works, or does not appear at all.
 */
import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ReportFilterOptions } from './types';
import { isoLocal, todayIso, weekStartFromDay, monthStart, humanise } from './report-utils';

/** Every filter the report suite understands. Tabs opt in by name. */
export interface ReportFilterState {
  fromDate: string;
  toDate: string;
  waiterId?: string;
  categoryId?: string;
  paymentMethod?: string;
  orderType?: string;
  status?: string;
  search?: string;
  itemSearch?: string;
  itemKey?: string;
  registerId?: string;
  includeCancelled?: boolean;
}

export type ReportFilterField =
  | 'waiter'
  | 'cashier'
  | 'category'
  | 'payment'
  | 'orderType'
  | 'orderStatus'
  | 'sessionStatus'
  | 'search'
  | 'itemSearch'
  | 'item'
  | 'register'
  | 'includeCancelled';

export const emptyFilters = (): ReportFilterState => ({ fromDate: todayIso(), toDate: todayIso() });

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-200';

const SESSION_STATUSES = [
  { id: 'open', name: 'Open' },
  { id: 'closed', name: 'Closed' },
  { id: 'reconciled', name: 'Reconciled' },
];

/**
 * Filter keys a tab does NOT declare are dropped before the request, so a
 * selection left over from another tab can never narrow a report that shows no
 * control for it.
 */
export function scopedFilters(state: ReportFilterState, fields: readonly ReportFilterField[]) {
  const has = (f: ReportFilterField) => fields.includes(f);
  return {
    waiterId: has('waiter') || has('cashier') ? state.waiterId : undefined,
    categoryId: has('category') ? state.categoryId : undefined,
    paymentMethod: has('payment') ? state.paymentMethod : undefined,
    orderType: has('orderType') ? state.orderType : undefined,
    status: has('orderStatus') || has('sessionStatus') ? state.status : undefined,
    search: has('search') ? state.search : undefined,
    itemSearch: has('itemSearch') ? state.itemSearch : undefined,
    itemKey: has('item') ? state.itemKey : undefined,
    registerId: has('register') ? state.registerId : undefined,
  };
}

interface Props {
  state: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  fields: readonly ReportFilterField[];
  options?: ReportFilterOptions;
  /** Item options come from the item-sales report response, not filter-options. */
  itemOptions?: Array<{ key: string; name: string }>;
  onRefresh?: () => void;
  isFetching?: boolean;
  /** Rows currently rendered — shown so an empty table reads as data, not error. */
  resultCount?: number;
}

const ReportFilterBar: React.FC<Props> = ({ state, onChange, fields, options, itemOptions, onRefresh, isFetching, resultCount }) => {
  const has = (f: ReportFilterField) => fields.includes(f);
  const set = (patch: Partial<ReportFilterState>) => onChange({ ...state, ...patch });

  const presets = [
    { label: 'Today', get: () => ({ f: todayIso(), t: todayIso() }) },
    { label: 'Yesterday', get: () => { const d = new Date(); d.setDate(d.getDate() - 1); const s = isoLocal(d); return { f: s, t: s }; } },
    { label: 'This Week', get: () => ({ f: weekStartFromDay(todayIso()), t: todayIso() }) },
    { label: 'Last 7 Days', get: () => { const d = new Date(); d.setDate(d.getDate() - 6); return { f: isoLocal(d), t: todayIso() }; } },
    { label: 'This Month', get: () => ({ f: monthStart(todayIso().slice(0, 7)), t: todayIso() }) },
    { label: 'Last 30 Days', get: () => { const d = new Date(); d.setDate(d.getDate() - 29); return { f: isoLocal(d), t: todayIso() }; } },
    { label: 'This Year', get: () => ({ f: todayIso().slice(0, 4) + '-01-01', t: todayIso() }) },
  ];

  // Which non-date filters are actually narrowing the current view. Rendered as
  // removable chips so a forgotten selection can never masquerade as "no data".
  const chips: Array<{ key: keyof ReportFilterState; label: string; clear: Partial<ReportFilterState> }> = [];
  const nameOf = (list: Array<{ id: string; name: string }> | undefined, id?: string) =>
    list?.find((o) => o.id === id)?.name ?? humanise(id);
  if (state.waiterId && (has('waiter') || has('cashier'))) {
    chips.push({ key: 'waiterId', label: `${has('cashier') ? 'Cashier' : 'Waiter'}: ${nameOf(options?.waiters, state.waiterId)}`, clear: { waiterId: undefined } });
  }
  if (state.categoryId && has('category')) chips.push({ key: 'categoryId', label: `Category: ${nameOf(options?.categories, state.categoryId)}`, clear: { categoryId: undefined } });
  if (state.paymentMethod && has('payment')) chips.push({ key: 'paymentMethod', label: `Tender: ${humanise(state.paymentMethod)}`, clear: { paymentMethod: undefined } });
  if (state.orderType && has('orderType')) chips.push({ key: 'orderType', label: `Type: ${humanise(state.orderType)}`, clear: { orderType: undefined } });
  if (state.status && (has('orderStatus') || has('sessionStatus'))) chips.push({ key: 'status', label: `Status: ${humanise(state.status)}`, clear: { status: undefined } });
  if (state.registerId && has('register')) chips.push({ key: 'registerId', label: `Register: ${nameOf(options?.registers, state.registerId)}`, clear: { registerId: undefined } });
  if (state.search && has('search')) chips.push({ key: 'search', label: `Search: ${state.search}`, clear: { search: undefined } });
  if (state.itemSearch && has('itemSearch')) chips.push({ key: 'itemSearch', label: `Item: ${state.itemSearch}`, clear: { itemSearch: undefined } });
  if (state.itemKey && has('item')) chips.push({ key: 'itemKey', label: 'Item selected', clear: { itemKey: undefined } });
  if (state.includeCancelled && has('includeCancelled')) chips.push({ key: 'includeCancelled', label: 'Incl. cancelled', clear: { includeCancelled: false } });

  const clearAll = () =>
    onChange({ fromDate: state.fromDate, toDate: state.toDate });

  const rangeInvalid = Boolean(state.fromDate && state.toDate && state.fromDate > state.toDate);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label>From</Label>
          <Input type="date" value={state.fromDate} max={state.toDate || undefined} onChange={(e) => set({ fromDate: e.target.value })} />
        </div>
        <div>
          <Label>To</Label>
          <Input type="date" value={state.toDate} min={state.fromDate || undefined} onChange={(e) => set({ toDate: e.target.value })} />
        </div>

        {(has('waiter') || has('cashier')) && (
          <div className="min-w-[170px]">
            <Label>{has('cashier') ? 'Cashier' : 'Waiter'}</Label>
            <select className={SELECT_CLASS} value={state.waiterId ?? ''} onChange={(e) => set({ waiterId: e.target.value || undefined })}>
              <option value="">All {has('cashier') ? 'cashiers' : 'waiters'}</option>
              {(options?.waiters ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        )}

        {has('category') && (
          <div className="min-w-[170px]">
            <Label>Category</Label>
            <select className={SELECT_CLASS} value={state.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })}>
              <option value="">All categories</option>
              {(options?.categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}

        {has('orderType') && (
          <div className="min-w-[150px]">
            <Label>Order type</Label>
            <select className={SELECT_CLASS} value={state.orderType ?? ''} onChange={(e) => set({ orderType: e.target.value || undefined })}>
              <option value="">All types</option>
              {(options?.orderTypes ?? [{ id: 'dine_in', name: 'dine in' }, { id: 'takeaway', name: 'takeaway' }, { id: 'delivery', name: 'delivery' }]).map((t) => (
                <option key={t.id} value={t.id}>{humanise(t.id)}</option>
              ))}
            </select>
          </div>
        )}

        {has('payment') && (
          <div className="min-w-[160px]">
            <Label>Payment method</Label>
            <select className={SELECT_CLASS} value={state.paymentMethod ?? ''} onChange={(e) => set({ paymentMethod: e.target.value || undefined })}>
              <option value="">All tenders</option>
              {(options?.paymentMethods ?? []).map((m) => (
                // Tenders with no sales in the range stay selectable but are
                // marked, so "no card sales today" is a visible answer.
                <option key={m.id} value={m.id}>{humanise(m.id)}{m.seen ? '' : ' (none)'}</option>
              ))}
            </select>
          </div>
        )}

        {has('orderStatus') && (
          <div className="min-w-[150px]">
            <Label>Order status</Label>
            <select className={SELECT_CLASS} value={state.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
              <option value="">All statuses</option>
              {(options?.orderStatuses ?? []).map((s) => (
                <option key={s.id} value={s.id}>{humanise(s.id)}</option>
              ))}
            </select>
          </div>
        )}

        {has('sessionStatus') && (
          <div className="min-w-[150px]">
            <Label>Shift status</Label>
            <select className={SELECT_CLASS} value={state.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
              <option value="">All shifts</option>
              {SESSION_STATUSES.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        {has('register') && (
          <div className="min-w-[170px]">
            <Label>Register</Label>
            <select className={SELECT_CLASS} value={state.registerId ?? ''} onChange={(e) => set({ registerId: e.target.value || undefined })}>
              <option value="">All registers</option>
              {(options?.registers ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        )}

        {has('item') && (
          <div className="min-w-[190px]">
            <Label>Menu item</Label>
            <select className={SELECT_CLASS} value={state.itemKey ?? ''} onChange={(e) => set({ itemKey: e.target.value || undefined })}>
              <option value="">All items</option>
              {(itemOptions ?? []).map((i) => (
                <option key={i.key} value={i.key}>{i.name}</option>
              ))}
            </select>
          </div>
        )}

        {has('search') && (
          <div className="min-w-[190px]">
            <Label>Order / invoice #</Label>
            <Input
              placeholder="e.g. INV-1042"
              value={state.search ?? ''}
              onChange={(e) => set({ search: e.target.value || undefined })}
            />
          </div>
        )}

        {has('itemSearch') && (
          <div className="min-w-[170px]">
            <Label>Item name</Label>
            <Input
              placeholder="e.g. latte"
              value={state.itemSearch ?? ''}
              onChange={(e) => set({ itemSearch: e.target.value || undefined })}
            />
          </div>
        )}

        {has('includeCancelled') && (
          <label className="flex h-9 items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={Boolean(state.includeCancelled)}
              onChange={(e) => set({ includeCancelled: e.target.checked, status: e.target.checked ? state.status : state.status })}
            />
            Include cancelled
          </label>
        )}

        <div className="ml-auto flex items-end gap-2">
          {onRefresh ? (
            <Button variant="outline" onClick={onRefresh} disabled={isFetching}>
              <RefreshCw className={'h-4 w-4 mr-1' + (isFetching ? ' animate-spin' : '')} /> Refresh
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((p) => {
          const { f, t } = p.get();
          const active = state.fromDate === f && state.toDate === t;
          return (
            <button
              key={p.label}
              className={'pos-reports-tab ' + (active ? 'active' : '')}
              style={{ fontSize: 14, padding: '2px 8px' }}
              onClick={() => set({ fromDate: f, toDate: t })}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {(chips.length > 0 || rangeInvalid || typeof resultCount === 'number') && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {rangeInvalid ? (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 border border-amber-200">
              From is after To — the range is read in date order.
            </span>
          ) : null}
          {chips.map((c) => (
            <button
              key={String(c.key)}
              className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-sky-700 hover:bg-sky-100"
              onClick={() => set(c.clear)}
              title="Remove this filter"
            >
              {c.label}
              <X className="h-3.5 w-3.5" />
            </button>
          ))}
          {chips.length > 0 ? (
            <button className="text-slate-500 underline hover:text-slate-700" onClick={clearAll}>
              Clear all filters
            </button>
          ) : null}
          {typeof resultCount === 'number' ? (
            <span className="ml-auto text-slate-500">
              {resultCount} row{resultCount === 1 ? '' : 's'}
              {chips.length > 0 ? ' (filtered)' : ''}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default ReportFilterBar;
