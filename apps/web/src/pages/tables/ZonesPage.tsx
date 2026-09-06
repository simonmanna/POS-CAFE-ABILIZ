/**
 * Tables — Zones (dining areas / table categories) CRUD.
 *
 * Clean catalog management: one row per zone in a data table with color,
 * name, active-table count and view-order controls. Create and edit are
 * dialog-based; archive is confirmed via AlertDialog. The zone `key` is an
 * implementation detail (the stable slug PosTable.zone references) — it is
 * auto-derived from the name on create and only surfaces read-only in the
 * edit dialog.
 *
 * The same catalog drives the POS terminal + table selector grouping:
 * View Order here sets the group order there.
 *
 * Route: /tables/zones
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus,
  Archive,
  RotateCcw,
  Pencil,
  Map as MapIcon,
  ChevronUp,
  ChevronDown,
  ArrowLeft,
  Search,
  UtensilsCrossed,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useArchiveZone,
  useCreateZone,
  useDeletedZones,
  useRefreshZones,
  useRestoreZone,
  useTableZones,
  useTables,
  useUpdateZone,
} from '@/features/tables/api';
import type { PosTableZoneConfig } from '@/features/tables/types';
import { sortZones } from '@/features/tables/utils';
import { useAuthStore } from '@/stores/auth.store';

/** Preset palette + native picker for custom colors. */
const ZONE_COLORS = [
  '#10b981', '#22c55e', '#14b8a6', '#3b82f6', '#a855f7',
  '#ec4899', '#f59e0b', '#fb923c', '#ef4444', '#64748b',
];

type DialogState =
  | { mode: 'create' }
  | { mode: 'edit'; zone: PosTableZoneConfig }
  | null;

export const ZonesPage: React.FC = () => {
  const canManage = useAuthStore((s) => s.permissions.includes('tables:zones'));
  const { data: zones = [], isLoading } = useTableZones();
  const { data: deletedZones = [] } = useDeletedZones();
  const { data: tables = [] } = useTables({ active: true });
  const create = useCreateZone();
  const update = useUpdateZone();
  const archive = useArchiveZone();
  const restore = useRestoreZone();
  const refreshZones = useRefreshZones();

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [archiveTarget, setArchiveTarget] = useState<PosTableZoneConfig | null>(null);

  // ── Dialog form state ──
  const [fName, setFName] = useState('');
  const [fColor, setFColor] = useState(ZONE_COLORS[0]);
  const [fOrder, setFOrder] = useState(0);
  const [fActive, setActive] = useState(true);
  const active = useMemo(() => sortZones(zones), [zones]);
  const archived = useMemo(() => sortZones(deletedZones), [deletedZones]);

  /** Active-table count per zone key (drives the Tables column). */
  const tableCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tables) m.set(t.zone, (m.get(t.zone) ?? 0) + 1);
    return m;
  }, [tables]);

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = showArchived ? archived : active;
    if (!q) return list;
    return list.filter(
      (z) => z.name.toLowerCase().includes(q) || z.key.toLowerCase().includes(q),
    );
  }, [showArchived, active, archived, q]);

  /** Next free View Order — new zones land at the end. */
  const nextOrder = useMemo(
    () => active.reduce((max, z) => Math.max(max, z.sortOrder ?? 0), 0) + 1,
    [active],
  );

  /**
   * Error toast for a zone mutation. A 404 means the row is gone server-side
   * while the client still lists it (stale cache) — refetch so the phantom
   * row disappears instead of failing every retry.
   */
  function zoneError(e: any, fallback: string) {
    if (e?.response?.status === 404) {
      refreshZones();
      toast.error('That zone no longer exists — list refreshed');
      return;
    }
    toast.error(e?.response?.data?.message ?? fallback);
  }

  function openCreate() {
    setFName('');
    setFColor(ZONE_COLORS[0]);
    setFOrder(nextOrder);
    setActive(true);
    setDialog({ mode: 'create' });
  }

  function openEdit(z: PosTableZoneConfig) {
    setFName(z.name);
    setFColor(z.color);
    setFOrder(z.sortOrder);
    setActive(z.active);
    setDialog({ mode: 'edit', zone: z });
  }

  /** Quick Active ⇄ Inactive toggle straight from the row (same write as the dialog). */
  async function doToggleActive(z: PosTableZoneConfig) {
    try {
      await update.mutateAsync({ id: z.id, body: { active: !z.active } });
      toast.success(
        z.active
          ? `Zone "${z.name}" is now Inactive — hidden from POS`
          : `Zone "${z.name}" is now Active — visible in POS`,
      );
    } catch (e: any) {
      zoneError(e, 'Failed to change zone status');
    }
  }

  async function submitDialog() {
    if (!dialog) return;
    if (!fName.trim()) {
      toast.error('Zone name is required');
      return;
    }
    try {
      if (dialog.mode === 'create') {
        await create.mutateAsync({
          name: fName.trim(),
          color: fColor,
          sortOrder: fOrder,
          active: fActive,
        });
        toast.success(`Zone "${fName.trim()}" created`);
      } else {
        await update.mutateAsync({
          id: dialog.zone.id,
          body: {
            name: fName.trim(),
            color: fColor,
            sortOrder: fOrder,
            active: fActive,
          },
        });
        toast.success('Zone updated');
      }
      setDialog(null);
    } catch (e: any) {
      if (e?.response?.status === 404) {
        refreshZones();
        setDialog(null);
        toast.error('That zone no longer exists — list refreshed');
        return;
      }
      zoneError(e, 'Failed to save zone');
    }
  }

  /**
   * Move a zone one step up/down in View Order.
   *
   * Reindexes the whole list to 1..n rather than swapping the two rows'
   * sortOrder values: freshly created zones commonly share the same number
   * (the field defaults to 0), and swapping equal values is a silent no-op —
   * the arrow would appear dead. Only rows whose number actually changes are
   * PATCHed.
   */
  async function doMove(z: PosTableZoneConfig, dir: -1 | 1) {
    const idx = active.findIndex((a) => a.id === z.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= active.length) return;
    const next = [...active];
    next.splice(target, 0, ...next.splice(idx, 1));
    const writes = next
      .map((zone, i) => ({ zone, order: i + 1 }))
      .filter(({ zone, order }) => zone.sortOrder !== order);
    if (writes.length === 0) return;
    try {
      // Sequential, not Promise.all: each PATCH is audited and invalidates the
      // zone queries; concurrent writes race the refetch and can flicker the
      // list back to the pre-move order.
      for (const { zone, order } of writes) {
        await update.mutateAsync({ id: zone.id, body: { sortOrder: order } });
      }
    } catch (e: any) {
      zoneError(e, 'Failed to reorder zone');
    }
  }

  async function doArchive() {
    if (!archiveTarget) return;
    try {
      await archive.mutateAsync(archiveTarget.id);
      toast.success(`Zone "${archiveTarget.name}" archived`);
      setArchiveTarget(null);
    } catch (e: any) {
      zoneError(e, 'Failed to archive zone');
      setArchiveTarget(null);
    }
  }

  async function doRestore(z: PosTableZoneConfig) {
    try {
      await restore.mutateAsync(z.id);
      toast.success(`Zone "${z.name}" restored`);
    } catch (e: any) {
      zoneError(e, 'Failed to restore zone');
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-6">
      {/* ── Hero ── */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 text-white px-6 py-5 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-white/15 rounded-xl">
              <MapIcon className="w-6 h-6" />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
                Restaurant
              </div>
              <div className="text-2xl md:text-3xl font-extrabold tracking-tight">
                Table Zones
              </div>
              <div className="text-sm text-white/80 mt-0.5">
                Dining areas that group tables on the POS floor map.
                View Order sets where each zone appears.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canManage ? (
              <Button
                onClick={openCreate}
                className="bg-white text-blue-700 hover:bg-white/90"
              >
                <Plus className="w-4 h-4 mr-1.5" /> New Zone
              </Button>
            ) : null}
            <Button
              asChild
              variant="outline"
              className="border-white/30 bg-white/10 text-white hover:bg-white/20"
            >
              <Link to="/tables">
                <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Tables
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search zone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-8 text-sm"
            />
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setShowArchived(false)}
              className={`px-3 py-1.5 text-xs font-semibold transition ${
                !showArchived
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-white text-muted-foreground hover:bg-muted'
              }`}
            >
              Active ({active.length})
            </button>
            <button
              onClick={() => setShowArchived(true)}
              className={`px-3 py-1.5 text-xs font-semibold transition ${
                showArchived
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-white text-muted-foreground hover:bg-muted'
              }`}
            >
              Archived ({archived.length})
            </button>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {tables.length} active table{tables.length === 1 ? '' : 's'} across{' '}
            {active.length} zone{active.length === 1 ? '' : 's'}
          </div>
        </CardContent>
      </Card>

      {/* ── Zones table ── */}
      <div className="rounded-xl border border-border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="px-4 py-2.5 font-medium">Zone</th>
              <th className="px-4 py-2.5 font-medium text-center">Tables</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">View order</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  Loading zones…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <UtensilsCrossed className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="font-medium text-muted-foreground">
                    {showArchived
                      ? 'No archived zones'
                      : q
                        ? `No zones matching "${search}"`
                        : 'No zones yet — create your first dining area'}
                  </p>
                  {!showArchived && !q && canManage ? (
                    <Button onClick={openCreate} size="sm" className="mt-3">
                      <Plus className="w-3 h-3 mr-1" /> New Zone
                    </Button>
                  ) : null}
                </td>
              </tr>
            ) : (
              rows.map((z, i) => {
                const count = tableCounts.get(z.key) ?? 0;
                const isArchived = showArchived;
                return (
                  <tr
                    key={z.id}
                    className={`border-b last:border-0 hover:bg-muted/30 ${isArchived ? 'opacity-70' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="w-4 h-4 rounded-full shrink-0 border border-slate-200"
                          style={{ background: z.color }}
                          title={z.key}
                        />
                        <div className="min-w-0">
                          <div className={`font-semibold truncate ${isArchived ? 'line-through text-muted-foreground' : ''}`}>
                            {z.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isArchived ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${
                            count > 0
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-slate-50 text-slate-400 border-slate-200'
                          }`}
                        >
                          {count} table{count === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isArchived ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <button
                          type="button"
                          disabled={!canManage || update.isPending}
                          onClick={() => doToggleActive(z)}
                          title={
                            canManage
                              ? z.active
                                ? 'Click to hide this zone from the POS terminal'
                                : 'Click to show this zone in the POS terminal'
                              : 'Requires the tables:zones permission'
                          }
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition ${
                            z.active
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                              : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                          } ${!canManage ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                        >
                          <span
                            className={`w-2 h-2 rounded-full ${z.active ? 'bg-emerald-500' : 'bg-slate-400'}`}
                          />
                          {z.active ? 'Active' : 'Inactive'}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isArchived ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-muted-foreground w-8">
                            #{z.sortOrder}
                          </span>
                          {canManage ? (
                            <div className="flex flex-col gap-0.5">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-6 text-slate-500"
                                onClick={() => doMove(z, -1)}
                                disabled={update.isPending || i === 0}
                                title="Move up"
                              >
                                <ChevronUp className="w-3 h-3" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-6 text-slate-500"
                                onClick={() => doMove(z, 1)}
                                disabled={update.isPending || i === rows.length - 1}
                                title="Move down"
                              >
                                <ChevronDown className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canManage ? (
                          isArchived ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              onClick={() => doRestore(z)}
                              disabled={restore.isPending}
                            >
                              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
                            </Button>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8"
                                onClick={() => openEdit(z)}
                                title="Edit zone"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => setArchiveTarget(z)}
                                disabled={archive.isPending}
                                title="Archive zone"
                              >
                                <Archive className="w-3.5 h-3.5" />
                              </Button>
                            </>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Create / Edit dialog ── */}
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === 'edit' ? 'Edit zone' : 'New zone'}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === 'edit'
                ? 'Rename, recolor, reorder or hide this zone from the POS.'
                : 'A dining area that groups tables on the POS floor map.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Name
              </label>
              <Input
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="e.g. Rooftop, Garden, VIP"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Color
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {ZONE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setFColor(c)}
                    className={`w-7 h-7 rounded-full border-2 transition ${
                      fColor.toLowerCase() === c.toLowerCase()
                        ? 'border-slate-800 scale-110'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ background: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={fColor}
                  onChange={(e) => setFColor(e.target.value)}
                  className="h-7 w-9 rounded cursor-pointer border border-slate-200 bg-white"
                  title="Custom color"
                />
              </div>
            </div>
            {dialog?.mode === 'edit' ? (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Key (read-only)
                </label>
                <Input
                  value={dialog.zone.key}
                  readOnly
                  className="font-mono text-xs text-slate-400 bg-slate-50"
                />
              </div>
            ) : null}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Zone status
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setActive(true)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold transition ${
                    fActive
                      ? 'border-emerald-400 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-emerald-200'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  Active
                </button>
                <button
                  type="button"
                  onClick={() => setActive(false)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold transition ${
                    !fActive
                      ? 'border-slate-400 bg-slate-100 text-slate-600'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-400" />
                  Inactive
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5">
                {fActive
                  ? 'Zone and its tables are shown in the POS selling terminal.'
                  : 'Zone and its tables are hidden from the POS selling terminal (tables keep their zone assignment).'}
              </p>
            </div>
            <div className="w-36">
              <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                View order
              </label>
              <Input
                type="number"
                value={fOrder}
                onChange={(e) => setFOrder(Number(e.target.value))}
              />
              <p className="text-[10px] text-slate-400 mt-1">
                Lower numbers appear first on the POS floor map.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button onClick={submitDialog} disabled={busy}>
              {dialog?.mode === 'edit' ? 'Save changes' : 'Create zone'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Archive confirm ── */}
      <AlertDialog
        open={!!archiveTarget}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive "{archiveTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The zone is removed from the POS floor map and from table
              assignment. Zones with active tables cannot be archived —
              reassign those tables first. Archived zones can be restored
              anytime. (To temporarily hide a zone from the POS without
              removing it, set its status to Inactive instead.)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={doArchive}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ZonesPage;
