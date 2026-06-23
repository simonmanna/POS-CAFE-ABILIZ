import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  LayoutGrid,
  RefreshCw,
  Sparkles,
  Brush,
  Link2,
  ArrowRightLeft,
  Users,
  Clock,
  X,
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
  useCleanTable,
  useMergeTables,
  useTableStats,
  useTables,
  useTransferTable,
  useUnmergeTable,
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
  'reserved',
  'dirty',
  'out_of_service',
];

export const TableSelectorDialog: React.FC<Props> = ({
  open,
  onClose,
  onPick,
  selectedId,
}) => {
  const { data: tables = [], refetch, isLoading } = useTables({ active: true });
  const { data: stats } = useTableStats();
  const clean = useCleanTable();
  const merge = useMergeTables();
  const transfer = useTransferTable();
  const unmerge = useUnmergeTable();

  const [filter, setFilter] = useState<'all' | PosTableStatus>('all');
  const [search, setSearch] = useState('');
  const [actionTable, setActionTable] = useState<PosTable | null>(null);
  const [target, setTarget] = useState<PosTable | null>(null);
  const [mode, setMode] = useState<'merge' | 'transfer' | 'unmerge' | null>(null);

  useEffect(() => {
    if (!open) {
      setActionTable(null);
      setTarget(null);
      setMode(null);
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

  async function doClean(t: PosTable) {
    try {
      await clean.mutateAsync(t.id);
      toast.success(`T${t.number} marked clean`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to clean');
    }
  }

  async function doUnmerge(t: PosTable) {
    try {
      await unmerge.mutateAsync(t.id);
      toast.success(`T${t.number} unmerged`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to unmerge');
    }
  }

  async function doConfirm() {
    if (!actionTable || !target || !mode) return;
    try {
      if (mode === 'merge') {
        await merge.mutateAsync({ sourceId: actionTable.id, targetId: target.id });
        toast.success(`Merged T${actionTable.number} → T${target.number}`);
      } else {
        await transfer.mutateAsync({ sourceId: actionTable.id, targetId: target.id });
        toast.success(`Transferred orders to T${target.number}`);
      }
      setActionTable(null);
      setTarget(null);
      setMode(null);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Action failed');
    }
  }

  const closeActionMode = () => {
    setActionTable(null);
    setTarget(null);
    setMode(null);
  };

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
                      onClean={() => doClean(t)}
                      onAction={(m) => {
                        setActionTable(t);
                        setMode(m);
                        setTarget(null);
                      }}
                      onUnmerge={() => doUnmerge(t)}
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

        {/* Target picker (bottom sheet inside dialog) */}
        {actionTable && mode && (
          <div className="border-t border-slate-200 bg-white px-6 py-5 rounded-b-2xl animate-in slide-in-from-bottom">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-bold text-slate-800 text-sm">
                  {mode === 'merge' ? 'Merge' : 'Transfer'} T{actionTable.number}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {mode === 'merge'
                    ? 'Select a table to merge into.'
                    : 'Select an available table to receive the orders.'}
                </p>
              </div>
              <button
                onClick={closeActionMode}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-5 sm:grid-cols-6 lg:grid-cols-8 gap-2 max-h-36 overflow-y-auto">
              {tables
                .filter((x) => {
                  if (x.id === actionTable.id || x.mergedIntoId) return false;
                  if (mode === 'merge') return x.status !== 'occupied';
                  return x.status === 'available';
                })
                .map((x) => (
                  <button
                    key={x.id}
                    onClick={() => setTarget(x)}
                    className={`py-2 px-1 text-xs font-semibold rounded-lg border-2 transition ${
                      target?.id === x.id
                        ? 'border-slate-800 bg-slate-800 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    T{x.number}
                  </button>
                ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={closeActionMode}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!target || merge.isPending || transfer.isPending}
                onClick={doConfirm}
                className={`${
                  mode === 'merge'
                    ? 'bg-indigo-600 hover:bg-indigo-700'
                    : 'bg-pink-600 hover:bg-pink-700'
                } text-white rounded-lg`}
              >
                {mode === 'merge' ? 'Merge' : 'Transfer'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

const TableCard: React.FC<{
  table: PosTable;
  selected: boolean;
  onPick: () => void;
  onClean: () => void;
  onAction: (m: 'merge' | 'transfer' | 'unmerge') => void;
  onUnmerge: () => void;
}> = ({ table, selected, onPick, onClean, onAction, onUnmerge }) => {
  const meta = STATUS_META[table.status];
  const openOrders = (table.orders ?? []).filter((o) => !o.closedAt);
  const total = openOrders.reduce((s, o) => s + Number(o.document?.totalAmount ?? 0), 0);

  return (
    <div
      onClick={onPick}
      className={`relative rounded-2xl p-4 border cursor-pointer transition-all duration-200 
        bg-white shadow-sm hover:shadow-md hover:scale-[1.01]
        ${selected ? 'ring-2 ring-indigo-500 ring-offset-2 shadow-md' : ''}
      `}
    >
      {/* Status badge top-right */}
      <span
        className={`absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border 
          ${meta.pill} bg-white`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
        {meta.label}
      </span>

      {/* Table number & name */}
      <div className="mb-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
          T{table.number}
        </div>
        <div className="text-sm font-bold text-slate-800 leading-tight pr-14">
          {table.name}
        </div>
      </div>

      {/* Seats */}
      <div className="flex items-center text-[11px] text-slate-500 gap-1 mb-1">
        <Users className="w-3 h-3" /> {table.seats}
      </div>

      {/* Open order info */}
      {table.mergedIntoId && (
        <div className="text-[10px] text-orange-600 font-semibold mt-1">
          Merged · orders on T{table.mergedInto?.number ?? '?'}
        </div>
      )}
      {openOrders.length > 0 && (
        <>
          <div className="flex items-center text-[11px] text-slate-500 gap-1 mt-1">
            <Clock className="w-3 h-3" />
            {minutesBetween(openOrders[0].openedAt, null)}m
          </div>
          <div className="mt-1 text-right font-bold text-slate-700 text-xs">
            {fmtMoney(total)}
          </div>
        </>
      )}

      {/* Action buttons */}
      <div
        className="mt-3 flex flex-wrap gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        {table.status === 'dirty' && (
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-semibold flex items-center gap-1 transition"
            onClick={onClean}
          >
            <Brush className="w-3 h-3" /> Clean
          </button>
        )}
        {table.mergedIntoId ? (
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded-md bg-orange-50 text-orange-700 hover:bg-orange-100 font-semibold flex items-center gap-1 transition"
            onClick={onUnmerge}
          >
            <X className="w-3 h-3" /> Unmerge
          </button>
        ) : null}
        {openOrders.length > 0 && !table.mergedIntoId && (
          <>
            <button
              type="button"
              className="text-[10px] px-2 py-1 rounded-md bg-pink-50 text-pink-700 hover:bg-pink-100 font-semibold flex items-center gap-1 transition"
              onClick={() => onAction('transfer')}
            >
              <ArrowRightLeft className="w-3 h-3" /> Transfer
            </button>
            <button
              type="button"
              className="text-[10px] px-2 py-1 rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-semibold flex items-center gap-1 transition"
              onClick={() => onAction('merge')}
            >
              <Link2 className="w-3 h-3" /> Merge
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default TableSelectorDialog;