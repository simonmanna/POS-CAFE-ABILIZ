// Merge Tables — fold one or more other tables into the table being served.
//
// The server owns the whole act (`POST /pos/tables/:sourceId/merge/:targetId`):
// each source table's open tab is absorbed into this table's order, the source
// is freed and left pointing at the target (`mergedIntoId`), and the target is
// re-priced. So this dialog only has to pick the sources: it never moves items
// itself, and it never merges a table into itself.
//
// Multi-select on purpose — pushing two tables together for a party of eight is
// one decision at the floor, not two trips through a wizard.
import React, { useMemo, useState } from 'react';
import { CheckSquare, Square, Users, X, Merge as MergeIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTables } from '@/features/tables/api';
import { fmtMoney } from '@/features/tables/utils';
import type { PosTable } from '@/features/tables/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The table being served — every selected table merges INTO this one. */
  targetId: string | null;
  targetLabel?: string | null;
  /** Resolves with the tables to fold into the target. */
  onConfirm: (sourceIds: string[]) => void | Promise<void>;
  busy?: boolean;
}

/** Open (un-closed) tabs on a table, with their running total. */
const openTabs = (t: PosTable) => (t.orders ?? []).filter((o) => !o.closedAt);

const tabTotal = (t: PosTable) =>
  openTabs(t).reduce((s, o) => s + Number(o.order?.totalAmount ?? 0), 0);

export const MergeTablesDialog: React.FC<Props> = ({
  open, onClose, targetId, targetLabel, onConfirm, busy,
}) => {
  const { data: tables = [], isLoading } = useTables({ active: true });
  const [sel, setSel] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  React.useEffect(() => {
    if (!open) { setSel([]); setSearch(''); }
  }, [open]);

  /* Eligible sources mirror the server's own guards: not this table, not already
   * merged somewhere, not out of service, not reserved (a booking is an admin
   * override the floor must not silently consume). */
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tables
      .filter((t) => t.id !== targetId && !t.mergedIntoId
        && t.status !== 'out_of_service' && t.status !== 'reserved')
      .filter((t) => (q ? `${t.number} ${t.name} ${t.zone}`.toLowerCase().includes(q) : true))
      .sort((a, b) => a.number - b.number);
  }, [tables, targetId, search]);

  const toggle = (id: string) =>
    setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const selectedTables = candidates.filter((t) => sel.includes(t.id));
  const movingSeats = selectedTables.reduce((s, t) => s + Number(t.seats ?? 0), 0);
  const movingTotal = selectedTables.reduce((s, t) => s + tabTotal(t), 0);

  const confirm = async () => {
    if (sel.length === 0) return;
    await onConfirm(sel);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[620px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-indigo-500 to-indigo-700 text-white p-4">
          <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
            <MergeIcon className="h-4 w-4" />
            Merge Tables into {targetLabel ?? 'this table'}
          </DialogTitle>
        </DialogHeader>

        <div className="p-4 space-y-3">
          <p className="text-xs text-slate-500">
            Pick the tables to join. Their open items move onto {targetLabel ?? 'this table'} and
            the picked tables are freed.
          </p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search table…"
            className="h-9 text-sm"
          />

          <div className="space-y-2 max-h-[46vh] overflow-y-auto">
            {isLoading ? (
              <div className="text-center text-slate-400 py-8">Loading tables…</div>
            ) : candidates.length === 0 ? (
              <div className="text-center text-slate-400 py-8">No eligible tables</div>
            ) : (
              candidates.map((t) => {
                const checked = sel.includes(t.id);
                const tabs = openTabs(t);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t.id)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-lg border-2 text-left transition ${
                      checked ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    {checked
                      ? <CheckSquare className="h-5 w-5 text-indigo-600 shrink-0" />
                      : <Square className="h-5 w-5 text-slate-400 shrink-0" />}

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-slate-800 truncate">
                        T{t.number}{t.name ? ` · ${t.name}` : ''}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <Users className="h-3 w-3" /> {t.seats}
                        <span className="truncate">{t.zoneName ?? t.zone}</span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      {tabs.length > 0 ? (
                        <>
                          <div className="text-sm font-bold text-amber-700 tabular-nums">{fmtMoney(tabTotal(t))}</div>
                          <div className="text-[10px] text-slate-400">
                            {tabs.length} open {tabs.length === 1 ? 'order' : 'orders'}
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] font-bold uppercase text-emerald-600">Empty</div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50 gap-2">
          <div className="mr-auto text-xs text-slate-500">
            {sel.length === 0
              ? 'Nothing selected'
              : `${sel.length} table${sel.length === 1 ? '' : 's'} · +${movingSeats} seats · ${fmtMoney(movingTotal)}`}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            <X className="h-4 w-4 mr-1" /> Cancel
          </Button>
          <Button
            onClick={confirm}
            disabled={sel.length === 0 || busy || !targetId}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <MergeIcon className="h-4 w-4 mr-1" /> {busy ? 'Merging…' : 'Merge Tables'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MergeTablesDialog;
