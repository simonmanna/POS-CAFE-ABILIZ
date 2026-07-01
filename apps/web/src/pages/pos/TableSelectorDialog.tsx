import React, { useEffect, useMemo, useState } from 'react';
import {
  LayoutGrid,
  RefreshCw,
  Sparkles,
  Clock,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useTableStats,
  useTables,
  usePosTablesStream,
} from '@/features/tables/api';
import type { PosTable, PosTableStatus } from '@/features/tables/types';
import { STATUS_META, ZONE_LABEL, fmtMoney, minutesBetween } from '@/features/tables/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (table: PosTable) => void;
  selectedId: string | null;
}

const FILTERS: Array<'all' | PosTableStatus> = [
  'all',
  'available',
  'occupied',
  'out_of_service',
];

export const TableSelectorDialog: React.FC<Props> = ({
  open,
  onClose,
  onPick,
  selectedId,
}) => {
  usePosTablesStream();
  const { data: tables = [], refetch, isLoading } = useTables({ active: true });
  const { data: stats } = useTableStats();

  const [filter, setFilter] = useState<'all' | PosTableStatus>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) {
      setSearch('');
      setFilter('all');
    }
  }, [open]);

  const grouped = useMemo(() => {
    const filtered = tables.filter((t) => {
      if (filter !== 'all' && t.status !== filter) return false;
      const q = search.trim().toLowerCase();
      if (q) {
        const hay = `${t.number} ${t.name} ${t.zone} ${t.customZone ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const map = new Map<string, PosTable[]>();
    for (const t of filtered) {
      const key = t.zone === 'custom' && t.customZone ? `custom:${t.customZone}` : t.zone;
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.number - b.number);
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tables, filter, search]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[90vw] lg:max-w-6xl p-0 overflow-hidden bg-white rounded-2xl shadow-2xl">
        {/* Beautiful header */}
        <div className="relative bg-gradient-to-br from-indigo-50 via-white to-sky-50 px-6 py-5 rounded-t-2xl border-b border-slate-100/80">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-slate-800 text-xl font-bold">
              <div className="p-2 bg-white rounded-lg shadow-sm">
                <LayoutGrid className="w-5 h-5 text-indigo-500" />
              </div>
              Table Selection
            </DialogTitle>
          </DialogHeader>
        </div>

        {/* Stats + filter bar – clean & functional */}
        <div className="px-2 py-1 border-b border-slate-100 bg-white flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((k) => {
              const count =
                k === 'all'
                  ? stats?.total ?? 0
                  : stats?.[k as keyof typeof stats] ?? 0;
              const meta = k === 'all' ? null : STATUS_META[k as PosTableStatus];
              const active = filter === k;
              return (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border flex items-center gap-1.5 transition ${
                    active
                      ? 'bg-slate-800 text-white border-slate-800 shadow-sm'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {meta ? (
                    <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  ) : null}
                  {k === 'all' ? 'All' : meta?.label ?? k}
                  <span
                    className={`text-[10px] font-bold rounded-full px-1.5 ${
                      active
                        ? 'bg-white/20 text-white'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="ml-auto flex gap-2 items-center">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search table…"
              className="h-9 w-44 text-xs rounded-lg"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => refetch()}
            >
              <RefreshCw className="w-4 h-4 text-slate-500" />
            </Button>
          </div>
        </div>

        {/* Main grid area – wider, more columns */}
        <div className="flex-1 overflow-y-auto p-6 bg-stone-50/50 min-h-[320px] max-h-[60vh]">
          {isLoading ? (
            <div className="text-center text-slate-400 py-12">Loading tables…</div>
          ) : grouped.length === 0 ? (
            <div className="text-center text-slate-400 py-12">
              <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="font-semibold">No tables match this filter</p>
            </div>
          ) : (
            grouped.map(([zoneKey, list]) => (
              <div key={zoneKey} className="mb-8">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
                  {ZONE_LABEL[zoneKey] ?? zoneKey} · {list.length}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {list.map((t) => (
                    <TableCard
                      key={t.id}
                      table={t}
                      selected={t.id === selectedId}
                      onPick={() => onPick(t)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Legend + footer */}
        <div className="border-t border-slate-100 px-6 py-4 bg-white rounded-b-2xl flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-4 text-xs text-slate-500">
            {Object.values(STATUS_META).map((m) => (
              <div key={m.label} className="flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full ${m.dot} shadow-sm`} />
                {m.label}
              </div>
            ))}
          </div>
          <DialogFooter className="p-0 m-0">
            <Button variant="outline" size="sm" onClick={onClose} className="rounded-lg">
              Close
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const TableCard: React.FC<{
  table: PosTable;
  selected: boolean;
  onPick: () => void;
}> = ({ table, selected, onPick }) => {
  const meta = STATUS_META[table.status];
  const openOrders = (table.orders ?? []).filter((o) => !o.closedAt);
  const total = openOrders.reduce((s, o) => s + Number(o.document?.totalAmount ?? 0), 0);

  return (
      <div
      onClick={onPick}
      className={`relative rounded-xl p-3 border cursor-pointer transition-all duration-200 
        bg-white shadow-sm hover:shadow-md hover:scale-[1.01]
        ${selected ? 'ring-2 ring-indigo-500 ring-offset-2 shadow-md' : ''}
      `}
    >
      {/* Status badge top-right */}
      <span
        className={`absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border 
          ${meta.pill} bg-white`}
      >
        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
        {meta.label}
      </span>

      {/* Table number & name */}
      <div className="mb-2">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-0.5">
          T{table.number}
        </div>
        <div className="text-sm font-bold text-slate-800 leading-tight pr-14">
          {table.name}
        </div>
      </div>

      {/* Open order info — time & price on one line */}
      {table.mergedIntoId && (
        <div className="text-[11px] text-orange-600 font-semibold mt-1">
          Merged · orders on T{table.mergedInto?.number ?? '?'}
        </div>
      )}
      {openOrders.length > 0 ? (
        <div className="flex items-center justify-between mt-1 text-xs font-semibold text-slate-600">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {minutesBetween(openOrders[0].openedAt, null)}m
          </span>
          <span>{fmtMoney(total)}</span>
        </div>
      ) : (
        <div className="mt-1 text-xs text-slate-400 font-medium">Available</div>
      )}
    </div>
  );
};

export default TableSelectorDialog;