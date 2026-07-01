// Full-screen table picker with filters, zone grouping and merge/transfer actions.
import React, { useEffect, useMemo, useState } from 'react';
import { Users, RefreshCw, Link2, Unlink, ArrowRightLeft, Search, MapPin, ChevronDown, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { posApi } from './api';
import type { Table } from './types';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (table: Table) => void;
  selected: Table | null;
  onTablesChanged?: () => void;
}

type Filter = 'all' | 'available' | 'occupied' | 'reserved';

const statusLabel: Record<string, string> = { AVAILABLE: 'Available', OCCUPIED: 'Occupied', RESERVED: 'Reserved' };
const statusClass: Record<string, string> = {
  AVAILABLE: 'avail', OCCUPIED: 'occupied', RESERVED: 'reserved',
};
const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

export const TablePicker: React.FC<Props> = ({ open, onClose, onPick, selected, onTablesChanged }) => {
  const [tables, setTables] = useState<Table[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [actionTable, setActionTable] = useState<Table | null>(null);
  // 'merge' shows a target picker that performs a merge; 'transfer' shows a target picker that performs a transfer
  const [mode, setMode] = useState<'merge' | 'transfer' | null>(null);
  const [target, setTarget] = useState<Table | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set());

  const load = async () => {
    try { setTables(await posApi.listTables()); } catch { /* noop */ }
  };
  useEffect(() => { if (open) load(); }, [open]);

  const zones = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) if (t.zone) set.add(t.zone);
    return Array.from(set).sort();
  }, [tables]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tables.filter((t) => {
      if (filter !== 'all' && t.status !== filter.toUpperCase()) return false;
      if (zoneFilter && t.zone !== zoneFilter) return false;
      if (q && !String(t.number).includes(q) && !(t.zone || '').toLowerCase().includes(q)) return false;
      if (t.mergedInto) return false; // hide children; they're shown under their parent
      return true;
    });
  }, [tables, filter, search, zoneFilter]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, available: 0, occupied: 0, reserved: 0 };
    for (const t of tables) {
      if (t.mergedInto) continue;
      c.all += 1;
      if (t.status === 'AVAILABLE') c.available += 1;
      if (t.status === 'OCCUPIED') c.occupied += 1;
      if (t.status === 'RESERVED') c.reserved += 1;
    }
    return c;
  }, [tables]);

  const doUnmerge = async (t: Table) => {
    try {
      setBusy(true);
      await posApi.unmergeTables(t.id);
      await load(); onTablesChanged?.(); setActionTable(null);
    } finally { setBusy(false); }
  };

  const doMerge = async () => {
    if (!actionTable || !target) return;
    try {
      setBusy(true);
      await posApi.mergeTables(actionTable.id, target.id);
      await load(); onTablesChanged?.();
      setActionTable(null); setMode(null); setTarget(null);
    } catch (e: any) { alert(e?.response?.data?.message || 'Merge failed'); }
    finally { setBusy(false); }
  };

  const doTransfer = async () => {
    if (!actionTable || !target) return;
    try {
      setBusy(true);
      const orderIds = (actionTable.orders || []).filter((o) => o.status === 'OPEN').map((o) => o.id);
      await posApi.transferOrders(actionTable.id, target.id, orderIds);
      await load(); onTablesChanged?.();
      setActionTable(null); setMode(null); setTarget(null);
    } catch (e: any) { alert(e?.response?.data?.message || 'Transfer failed'); }
    finally { setBusy(false); }
  };

  const doSetStatus = async (t: Table, status: 'AVAILABLE' | 'RESERVED' | 'OCCUPIED') => {
    try {
      setBusy(true);
      await posApi.setTableStatus(t.id, status);
      await load(); onTablesChanged?.();
    } catch (e: any) { alert(e?.response?.data?.message || 'Status change failed'); }
    finally { setBusy(false); }
  };

  const grouped = useMemo(() => {
    const map: Record<string, Table[]> = {};
    for (const t of filtered) {
      const key = t.zone || 'No zone';
      if (!map[key]) map[key] = [];
      map[key].push(t);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const closeAll = () => { setActionTable(null); setMode(null); setTarget(null); };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-[920px] p-0 overflow-hidden">
          <DialogHeader className="bg-gradient-to-r from-[#1a7fcf] to-[#1565a8] text-white p-4">
            <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Table selection
            </DialogTitle>
            <DialogDescription className="text-blue-100 text-xs">
              Pick a table to start a new order, or transfer / merge an occupied one.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-slate-50 border-b border-slate-200 px-5 py-3 flex flex-wrap items-center gap-2">
            <div className="flex bg-white rounded-lg p-1 border border-slate-200">
              {([
                { k: 'all', label: 'All', c: '#1a7fcf' },
                { k: 'available', label: 'Available', c: '#16a34a' },
                { k: 'occupied', label: 'Occupied', c: '#f59e0b' },
                { k: 'reserved', label: 'Reserved', c: '#6366f1' },
              ] as { k: Filter; label: string; c: string }[]).map((f) => (
                <button
                  key={f.k}
                  type="button"
                  onClick={() => setFilter(f.k)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold"
                  style={{ background: filter === f.k ? f.c : 'transparent', color: filter === f.k ? '#fff' : '#64748b' }}
                >
                  {f.label}
                  <span
                    className="rounded px-1.5 text-[10px] font-extrabold"
                    style={{ background: filter === f.k ? 'rgba(255,255,255,.3)' : '#e2e8f0', color: filter === f.k ? '#fff' : '#0f172a' }}
                  >
                    {counts[f.k]}
                  </span>
                </button>
              ))}
            </div>
            {zones.length > 0 ? (
              <select
                value={zoneFilter || ''}
                onChange={(e) => setZoneFilter(e.target.value || null)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold"
              >
                <option value="">All zones</option>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            ) : null}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search table #"
                className="pl-8 h-8 text-xs w-36"
              />
            </div>
            <Button variant="outline" size="sm" onClick={load} className="ml-auto">
              <RefreshCw className="h-3 w-3 mr-1" /> Refresh
            </Button>
          </div>

          <div className="p-5 max-h-[60vh] overflow-y-auto">
            {grouped.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <div className="text-4xl mb-2">🪑</div>
                <p className="font-bold">No tables match the current filter</p>
              </div>
            ) : (
              <div className="space-y-4">
                {grouped.map(([zone, list]) => {
                  const open = expandedZones.has(zone) || grouped.length === 1 || filter !== 'all' || !!search;
                  return (
                    <div key={zone}>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs font-bold text-slate-500 uppercase tracking-wider mb-2"
                        onClick={() => {
                          const n = new Set(expandedZones);
                          if (n.has(zone)) n.delete(zone); else n.add(zone);
                          setExpandedZones(n);
                        }}
                      >
                        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {zone} · {list.length}
                      </button>
                      {open && (
                        <div className="pos-table-grid-pro">
                          {list.map((t) => {
                            const orderTotal = (t.orders || []).reduce((s, o) => s + (o.total || 0), 0);
                            const merged = t.mergedTables && t.mergedTables.length > 0;
                            return (
                              <div
                                key={t.id}
                                className={'pos-table-card-pro' + (merged ? ' merged' : '') + (selected?.id === t.id ? ' selected' : '')}
                                onClick={() => { onPick(t); onClose(); }}
                              >
                                <span className={'pos-table-status ' + statusClass[t.status]}>{statusLabel[t.status]}</span>
                                <div className="pos-table-num">T{t.number}</div>
                                {t.zone ? <div className="pos-table-zone">{t.zone}</div> : null}
                                <div className="pos-table-cap">
                                  <Users className="h-3 w-3" /> {t.capacity} seats
                                </div>
                                {merged ? (
                                  <div className="text-[10px] text-purple-700 font-bold mt-1">
                                    merged with {t.mergedTables!.map((m) => `T${m.number}`).join(', ')}
                                  </div>
                                ) : null}
                                {orderTotal > 0 ? <div className="pos-table-amount">{fmt(orderTotal)}</div> : null}
                                <div className="absolute bottom-2 left-3 flex gap-1" onClick={(e) => e.stopPropagation()}>
                                  {t.status === 'AVAILABLE' ? (
                                    <button type="button" className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold" onClick={() => doSetStatus(t, 'RESERVED')}>Reserve</button>
                                  ) : null}
                                  {t.status === 'RESERVED' ? (
                                    <button type="button" className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold" onClick={() => doSetStatus(t, 'AVAILABLE')}>Clear</button>
                                  ) : null}
                                  {t.status === 'OCCUPIED' ? (
                                    <button type="button" className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 font-bold" onClick={() => doSetStatus(t, 'AVAILABLE')}>Free</button>
                                  ) : null}
                                  {(t.status === 'OCCUPIED' || merged) ? (
                                    <button type="button" className="text-[10px] px-1.5 py-0.5 rounded bg-pink-50 text-pink-700 hover:bg-pink-100 font-bold" onClick={() => setActionTable(t)}>Actions</button>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50">
            <p className="text-xs text-slate-500 mr-auto">
              {tables.length} tables · {counts.available} available · {counts.occupied} occupied · {counts.reserved} reserved
            </p>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action sheet (merge / transfer / unmerge) */}
      <Dialog open={!!actionTable && !mode} onOpenChange={(o) => !o && closeAll()}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Table T{actionTable?.number} actions</DialogTitle>
            <DialogDescription>Choose how to handle the open orders on this table.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            <Button variant="outline" className="justify-start" onClick={() => setMode('transfer')} disabled={busy}>
              <ArrowRightLeft className="h-4 w-4 mr-2" /> Transfer orders to another table
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => setMode('merge')} disabled={busy}>
              <Link2 className="h-4 w-4 mr-2" /> Merge into another table
            </Button>
            {actionTable?.mergedTables && actionTable.mergedTables.length > 0 ? (
              <Button variant="outline" className="justify-start text-rose-600" onClick={() => doUnmerge(actionTable)} disabled={busy}>
                <Unlink className="h-4 w-4 mr-2" /> Unmerge all tables
              </Button>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAll}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Target picker (shared by merge & transfer) */}
      <Dialog open={!!actionTable && !!mode} onOpenChange={(o) => !o && closeAll()}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {mode === 'merge' ? `Merge T${actionTable?.number} into…` : `Transfer T${actionTable?.number} orders to…`}
            </DialogTitle>
            <DialogDescription>
              {mode === 'merge' ? 'The source table becomes part of the target group.' : 'All open orders will move to the target table.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto">
            {tables
              .filter((t) => t.id !== actionTable?.id && !t.mergedInto)
              .filter((t) => mode === 'merge' ? t.status !== 'OCCUPIED' : true)
              .map((t) => (
                <Button key={t.id} variant={target?.id === t.id ? 'default' : 'outline'} onClick={() => setTarget(t)}>
                  T{t.number}
                </Button>
              ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAll}>Cancel</Button>
            <Button onClick={mode === 'merge' ? doMerge : doTransfer} disabled={!target || busy}>
              {mode === 'merge' ? 'Merge' : 'Transfer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
