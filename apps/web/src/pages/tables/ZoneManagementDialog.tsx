/**
 * Zone Management — configurable dining areas / table categories.
 *
 * Full CRUD for the PosTableZone catalog: create, rename, recolor, reorder,
 * archive (soft delete — refused while active tables reference the zone) and
 * restore. Ordered by View Order (sortOrder) — the same order POS selling
 * pages use when grouping tables by zone. Opened from TablesPage's "Manage
 * Zones" hero action (gated behind the `tables:zones` permission).
 */
import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Archive,
  RotateCcw,
  Pencil,
  Map,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  useRestoreZone,
  useTableZones,
  useUpdateZone,
} from '@/features/tables/api';
import type { PosTableZoneConfig } from '@/features/tables/types';
import { sortZones } from '@/features/tables/utils';

/** Mirror of the API slugifier (lowercase, alnum+underscore, max 40). */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'zone';
}

export const ZoneManagementDialog: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const { data: zones = [], isLoading } = useTableZones();
  const { data: deletedZones = [] } = useDeletedZones();
  const create = useCreateZone();
  const update = useUpdateZone();
  const archive = useArchiveZone();
  const restore = useRestoreZone();

  // ── Create form ──
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [color, setColor] = useState('#10b981');
  const [sortOrder, setSortOrder] = useState(0);
  const [keyTouched, setKeyTouched] = useState(false);

  // ── Full edit dialog ──
  const [editTarget, setEditTarget] = useState<PosTableZoneConfig | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#10b981');
  const [editOrder, setEditOrder] = useState(0);

  const active = useMemo(() => sortZones(zones.filter((z) => !z.deletedAt)), [zones]);
  const archived = useMemo(() => sortZones(deletedZones), [deletedZones]);

  const keyPreview = keyTouched ? key : slugify(name);

  function resetForm() {
    setName('');
    setKey('');
    setColor('#10b981');
    setSortOrder(0);
    setKeyTouched(false);
  }

  async function doCreate() {
    if (!name.trim()) {
      toast.error('Zone name is required');
      return;
    }
    try {
      await create.mutateAsync({
        key: keyTouched && key.trim() ? key.trim() : undefined,
        name: name.trim(),
        color,
        sortOrder,
      });
      toast.success(`Zone "${name.trim()}" created`);
      resetForm();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to create zone');
    }
  }

  function openEdit(z: PosTableZoneConfig) {
    setEditTarget(z);
    setEditName(z.name);
    setEditColor(z.color);
    setEditOrder(z.sortOrder);
  }

  function closeEdit() {
    setEditTarget(null);
  }

  async function doSaveEdit() {
    if (!editTarget) return;
    if (!editName.trim()) {
      toast.error('Zone name is required');
      return;
    }
    try {
      await update.mutateAsync({
        id: editTarget.id,
        body: { name: editName.trim(), color: editColor, sortOrder: editOrder },
      });
      toast.success('Zone updated');
      closeEdit();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to update zone');
    }
  }

  /** Move a zone one step up/down in View Order (swaps sortOrder values). */
  async function doMove(z: PosTableZoneConfig, dir: -1 | 1) {
    const idx = active.findIndex((a) => a.id === z.id);
    if (idx < 0) return;
    const other = active[idx + dir];
    if (!other) return;
    try {
      await Promise.all([
        update.mutateAsync({ id: z.id, body: { sortOrder: other.sortOrder } }),
        update.mutateAsync({ id: other.id, body: { sortOrder: z.sortOrder } }),
      ]);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to reorder zone');
    }
  }

  async function doArchive(z: PosTableZoneConfig) {
    try {
      await archive.mutateAsync(z.id);
      toast.success(`Zone "${z.name}" archived`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to archive zone');
    }
  }

  async function doRestore(z: PosTableZoneConfig) {
    try {
      await restore.mutateAsync(z.id);
      toast.success(`Zone "${z.name}" restored`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to restore zone');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Map className="w-5 h-5 text-slate-500" /> Manage Zones
          </DialogTitle>
          <DialogDescription>
            Dining areas &amp; table categories — create, rename, recolor and
            reorder. View Order controls the position of each zone on the POS
            selling pages. Archiving is refused while active tables still
            reference a zone.
          </DialogDescription>
        </DialogHeader>

        {/* ── Create form ── */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            New zone
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="col-span-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Rooftop"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Key
              </label>
              <Input
                value={keyPreview}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyTouched(true);
                }}
                placeholder={slugify(name) || 'zone'}
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                Color
              </label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-10 w-full rounded-md border border-slate-200 bg-white cursor-pointer"
              />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-32">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                View order
              </label>
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
              />
            </div>
            <p className="flex-1 text-[11px] text-slate-400 leading-snug pb-2">
              Lower numbers appear first — sets the zone's position on the POS
              selling pages.
            </p>
            <Button
              onClick={doCreate}
              disabled={create.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <Plus className="w-4 h-4 mr-1.5" /> Add zone
            </Button>
          </div>
        </div>

        {/* ── Active zones ── */}
        <div className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Active zones ({active.length})
          </div>
          {isLoading ? (
            <div className="text-sm text-slate-400 py-4 text-center">Loading zones…</div>
          ) : active.length === 0 ? (
            <div className="text-sm text-slate-400 py-4 text-center">
              No zones yet — add one above.
            </div>
          ) : (
            active.map((z, i) => (
              <div
                key={z.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
              >
                <span
                  className="w-4 h-4 rounded-full shrink-0 border border-slate-200"
                  style={{ background: z.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold truncate">{z.name}</div>
                  <div className="text-[11px] text-slate-400 font-mono">{z.key}</div>
                </div>
                <div className="text-[11px] text-slate-500 w-14 text-right" title="View order">
                  #{z.sortOrder}
                </div>
                <div className="flex flex-col gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-6 text-slate-500"
                    onClick={() => doMove(z, -1)}
                    disabled={update.isPending || i === 0}
                    title="Move up in view order"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-6 text-slate-500"
                    onClick={() => doMove(z, 1)}
                    disabled={update.isPending || i === active.length - 1}
                    title="Move down in view order"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-slate-500"
                  onClick={() => openEdit(z)}
                  title="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-rose-600 hover:text-rose-700"
                  onClick={() => doArchive(z)}
                  disabled={archive.isPending}
                  title="Archive"
                >
                  <Archive className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>

        {/* ── Archived zones ── */}
        {archived.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Archived ({archived.length})
            </div>
            {archived.map((z) => (
              <div
                key={z.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 opacity-70"
              >
                <span
                  className="w-4 h-4 rounded-full shrink-0 border border-slate-200"
                  style={{ background: z.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold truncate line-through">{z.name}</div>
                  <div className="text-[11px] text-slate-400 font-mono">{z.key}</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => doRestore(z)}
                  disabled={restore.isPending}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {/* ── Full edit dialog ── */}
        <Dialog open={!!editTarget} onOpenChange={(o) => !o && closeEdit()}>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>Edit zone</DialogTitle>
              <DialogDescription>
                Rename, recolor, or change where this zone appears. View Order
                controls its position on the POS selling pages — lower numbers
                first.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Name
                </label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Rooftop"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Key (immutable)
                </label>
                <Input
                  value={editTarget?.key ?? ''}
                  readOnly
                  className="font-mono text-slate-500 bg-slate-50"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Color
                  </label>
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="h-10 w-full rounded-md border border-slate-200 bg-white cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    View order
                  </label>
                  <Input
                    type="number"
                    value={editOrder}
                    onChange={(e) => setEditOrder(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={closeEdit}>
                Cancel
              </Button>
              <Button
                onClick={doSaveEdit}
                disabled={update.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                Save changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
};

export default ZoneManagementDialog;
