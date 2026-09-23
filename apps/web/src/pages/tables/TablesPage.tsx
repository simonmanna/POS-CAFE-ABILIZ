/**
 * POS Tables Management — list + create + edit + archive + status flips.
 *
 * Pattern: shadcn Table for the list, Dialog for create/edit, AlertDialog
 * for archive confirmation. Polls /pos/tables every 20s; stats every 15s.
 * Live updates via SSE when connected.
 */
import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  RefreshCw,
  Pencil,
  Archive,
  Sparkles,
  PowerOff,
  UtensilsCrossed,
  LayoutGrid,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  Map as MapIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  useArchiveTable,
  useCreateTable,
  useSetTableStatus,
  useTables,
  useTableStats,
  useTableZones,
  useUpdateTable,
  usePosTablesStream,
} from '@/features/tables/api';
import type {
  CreateTableInput,
  PosTable,
  PosTableShape,
  PosTableStatus,
  PosTableZone,
  UpdateTableInput,
} from '@/features/tables/types';
import { STATUS_META, statusMeta, fmtMoney, sortZones, zoneLabel, zoneRankMap, compareZoneKeys } from '@/features/tables/utils';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { TableDetailDialog } from './TableDetailDialog';

type FormState = Omit<CreateTableInput, 'number'> & { number: string };

const EMPTY_FORM: FormState = {
  name: '',
  number: '',
  seats: 2,
  zone: 'indoor',
  shape: 'square',
  notes: '',
  active: true,
  sortOrder: 0,
  qrCodeUrl: '',
};

const SHAPES: PosTableShape[] = ['square', 'rectangle', 'circle'];

export const TablesPage: React.FC = () => {
  usePosTablesStream();
  const { data: tables = [], isLoading, refetch } = useTables({ active: true });
  const { data: stats } = useTableStats();
  const { data: zones = [] } = useTableZones();
  const canManageZones = useAuthStore((s) => s.permissions.includes('tables:zones'));
  const create = useCreateTable();
  const update = useUpdateTable();
  const archive = useArchiveTable();
  const setStatus = useSetTableStatus();

  const [filter, setFilter] = useState<'all' | PosTableStatus>('all');
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PosTable | null>(null);
  const [viewTarget, setViewTarget] = useState<PosTable | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<PosTable | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  /** Tables grouped per zone key (list view sections). */
  const zoneSections = useMemo(() => {
    const map = new Map<string, PosTable[]>();
    for (const t of tables) {
      const arr = map.get(t.zone) ?? [];
      arr.push(t);
      map.set(t.zone, arr);
    }
    return map;
  }, [tables]);

  /** Per-zone table ids in display order (sortOrder asc, ties by number). */
  const zoneOrders = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [zone, list] of zoneSections) {
      map.set(zone, [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.number - b.number).map((t) => t.id));
    }
    return map;
  }, [zoneSections]);

  /**
   * Move a table one position within its zone (up = toward the front of the
   * picker, down = toward the back). Persists the zone's renumbered sortOrder
   * values, then refreshes the list.
   */
  async function moveTable(table: PosTable, dir: 'up' | 'down') {
    const order = zoneOrders.get(table.zone) ?? [];
    const idx = order.indexOf(table.id);
    if (idx < 0) return;
    const to = dir === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [movedId] = next.splice(idx, 1);
    next.splice(to, 0, movedId);
    const byId = new Map(tables.map((t) => [t.id, t] as const));
    const changed = next
      .map((id, i) => ({ table: byId.get(id), sortOrder: i }))
      .filter((x): x is { table: PosTable; sortOrder: number } => !!x.table)
      .filter((x) => (x.table.sortOrder ?? 0) !== x.sortOrder);
    if (changed.length === 0) return;
    try {
      await Promise.all(
        changed.map((x) => api.patch(`/pos/tables/${x.table.id}`, { sortOrder: x.sortOrder })),
      );
      toast.success(`T${movedId === table.id ? table.number : byId.get(movedId)?.number} moved ${dir === 'up' ? 'toward the front' : 'toward the back'}`);
      refetch();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to reorder table');
    }
  }

  /**
   * Tables grouped per zone for rendering — one section with a header per
   * zone, matching the POS terminal picker. Within a zone, tables follow the
   * picker order (sortOrder asc, ties by number). Zone groups follow the
   * zone catalog's View Order, so management and the terminal agree.
   */
  const grouped = useMemo(() => {
    const q = search.toLowerCase().trim();
    const byZone = new Map<string, PosTable[]>();
    for (const t of [...tables].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.number - b.number)) {
      if (filter !== 'all' && t.status !== filter) continue;
      if (zoneFilter !== 'all' && t.zone !== zoneFilter) continue;
      if (q) {
        const hay = `${t.name} ${t.number} ${t.zoneName ?? t.zone}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const arr = byZone.get(t.zone) ?? [];
      arr.push(t);
      byZone.set(t.zone, arr);
    }
    const rank = zoneRankMap(zones);
    return Array.from(byZone.entries()).sort((a, b) => compareZoneKeys(rank, a[0], b[0]));
  }, [tables, filter, zoneFilter, search, zones]);

  function openCreate() {
    setForm({ ...EMPTY_FORM, number: String((tables.at(-1)?.number ?? 0) + 1) });
    setCreateOpen(true);
  }

  function openEdit(table: PosTable) {
    setEditTarget(table);
    setForm({
      name: table.name,
      number: String(table.number),
      seats: table.seats,
      zone: table.zone,
      shape: table.shape,
      notes: table.notes ?? '',
      active: table.active,
      sortOrder: table.sortOrder,
      qrCodeUrl: table.qrCodeUrl ?? '',
    });
  }

  async function submitCreate() {
      const number = Number(form.number);
      if (!form.name.trim() || !Number.isFinite(number)) {
        toast.error('Name and a numeric "number" are required');
        return;
      }
      const body: CreateTableInput = {
        name: form.name.trim(),
        number,
        seats: Number(form.seats ?? 2),
        zone: form.zone,
        shape: form.shape,
        notes: form.notes?.trim() || undefined,
        active: form.active,
        sortOrder: form.sortOrder,
        qrCodeUrl: form.qrCodeUrl?.trim() || undefined,
      };
      try {
        await create.mutateAsync(body);
        toast.success(`Created T${number}`);
        setCreateOpen(false);
      } catch (e: any) {
        toast.error(e?.response?.data?.message ?? 'Failed to create table');
      }
    }

  async function submitEdit() {
        if (!editTarget) return;
        const number = Number(form.number);
        if (!Number.isFinite(number)) {
          toast.error('Number is required');
          return;
        }
        const body: UpdateTableInput = {
          name: form.name.trim(),
          number,
          seats: Number(form.seats ?? 2),
          zone: form.zone,
          shape: form.shape,
          notes: form.notes?.trim() || undefined,
          active: form.active,
          sortOrder: Number(form.sortOrder ?? 0),
          qrCodeUrl: form.qrCodeUrl?.trim() || undefined,
        };
        try {
          await update.mutateAsync({ id: editTarget.id, body });
          toast.success(`Updated T${number}`);
          setEditTarget(null);
        } catch (e: any) {
          const msg = e?.response?.data?.message ?? e?.message ?? 'Failed to update table';
          toast.error(msg);
          console.error('Update table error:', e?.response?.data ?? e);
        }
      }

  async function doArchive() {
    if (!archiveTarget) return;
    try {
      await archive.mutateAsync(archiveTarget.id);
      toast.success(`T${archiveTarget.number} archived`);
      setArchiveTarget(null);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to archive table');
    }
  }

  async function toggleOutOfService(table: PosTable) {
    const next: PosTableStatus = table.status === 'out_of_service' ? 'available' : 'out_of_service';
    try {
      await setStatus.mutateAsync({ id: table.id, status: next, reason: 'manual-toggle' });
      toast.success(`T${table.number} → ${STATUS_META[next].label}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Failed to change status');
    }
  }

  return (
    <div className=" p-3 space-y-1">
      {/* ── Hero ── */}
      <div className="page-hero hero-strip">
        <div className="page-hero-inner">
          <div className="flex items-center gap-1">
            <div className="flex h-10 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 text-2xl">
              <UtensilsCrossed className="h-7 w-7" />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
                Restaurant
              </div>
              <div className="text-2xl md:text-3xl font-extrabold tracking-tight">
                Tables
              </div>
              <div className="text-sm text-white/80 mt-0.5">
                Manage seats, status, merge and transfer — all in real time.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" className="border-white/30 bg-white/10 text-white hover:bg-white/20">
              <a href="/tables/reservations">
                <CalendarPlusIcon /> Reservations
              </a>
            </Button>
            <Button asChild variant="outline" className="border-white/30 bg-white/10 text-white hover:bg-white/20">
              <a href="/tables/reports">
                <BarChart3Icon /> Reports
              </a>
            </Button>
            {canManageZones ? (
              <Button
                asChild
                variant="outline"
                className="border-white/30 bg-white/10 text-white hover:bg-white/20"
              >
                <a href="/tables/zones">
                  <MapIcon className="w-4 h-4 mr-1.5" /> Manage Zones
                </a>
              </Button>
            ) : null}
            <Button
              onClick={openCreate}
              className="bg-white text-blue-700 hover:bg-white/90 btn-shine shadow-lg"
            >
              <Plus className="w-4 h-4 mr-1.5" /> New Table
            </Button>
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="glass-card p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="section-title mr-2">Status</span>
          {(['all', 'available', 'occupied', 'reserved', 'out_of_service'] as const).map(
            (k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`pill transition-all ${
                  filter === k
                    ? 'bg-primary text-primary-foreground shadow-md shadow-blue-500/30'
                    : 'bg-white text-muted-foreground border border-border hover:border-primary hover:text-primary'
                }`}
              >
                {k === 'all' ? 'All' : STATUS_META[k as PosTableStatus].label}
                {k !== 'all' && stats
                  ? ` · ${stats[k as keyof typeof stats] ?? 0}`
                  : null}
              </button>
            ),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="section-title mr-2">Zone</span>
          <button
            onClick={() => setZoneFilter('all')}
            className={`pill transition-all ${
              zoneFilter === 'all'
                ? 'bg-slate-700 text-white shadow-md'
                : 'bg-white text-muted-foreground border border-border hover:border-slate-400 hover:text-slate-600'
            }`}
          >
            All · {tables.length}
          </button>
          {sortZones(zones).map((z) => {
            const count = zoneSections.get(z.key)?.length ?? 0;
            return (
              <button
                key={z.id}
                onClick={() => setZoneFilter(z.key)}
                className={`pill transition-all inline-flex items-center gap-1.5 ${
                  zoneFilter === z.key
                    ? 'bg-slate-700 text-white shadow-md'
                    : 'bg-white text-muted-foreground border border-border hover:border-slate-400 hover:text-slate-600'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: z.color }}
                />
                {z.name} · {count}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <div className="relative w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by name, number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-8 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={openCreate} className="btn-shine shadow-md shadow-blue-500/20">
            <Plus className="w-3 h-3 mr-1" /> New Table
          </Button>
        </div>
      </div>

      {/* ── Zones ── */}
      {isLoading ? (
        <div className="text-slate-400 py-10 text-center">Loading tables…</div>
      ) : grouped.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-400">
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="font-bold">
              {tables.length === 0
                ? 'No tables yet — create your first one!'
                : search
                  ? `No tables matching "${search}"`
                  : `No ${filter === 'all' ? '' : filter} tables`}
            </p>
            {tables.length === 0 ? (
              <Button onClick={openCreate} className="mt-4" size="sm">
                <Plus className="w-3 h-3 mr-1" /> Create Table
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        grouped.map(([zoneKey, list]) => {
          const zMeta = zones.find((z) => z.key === zoneKey);
          return (
            <div key={zoneKey} className="space-y-1">
              {/* Zone header — same pattern as the POS terminal picker */}
              <div className="flex items-center gap-2 px-1 pt-4 pb-1 text-xs font-bold uppercase tracking-wider text-slate-500">
                <span
                  className="w-2.5 h-2.5 rounded-full shadow-sm"
                  style={{ background: zMeta?.color ?? '#cbd5e1' }}
                />
                {zoneLabel(zones, zoneKey)}
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
                  {list.length} table{list.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1">
                {list.map((table) => {
            const meta = statusMeta(table.status);
            const openOrders = (table.orders ?? []).filter((o) => !o.closedAt);
            const total = openOrders.reduce((s, o) => s + Number(o.order?.totalAmount ?? 0), 0);
            return (
              <Card
                key={table.id}
                className={`group relative overflow-hidden border-2 ${meta.border} ${meta.bg} transition cursor-pointer lift-on-hover hover:border-primary/40`}
                onClick={() => setViewTarget(table)}
              >
                {/* Subtle gradient overlay for visual interest */}
                <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
                     style={{ background: 'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, transparent 50%)' }} />
                <CardContent className="relative p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-muted-foreground flex items-center gap-1">
                        <LayoutGrid className="w-3 h-3" /> T{table.number}
                      </div>
                      <div className="text-lg font-extrabold text-foreground leading-tight">
                        {table.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ background: table.zoneColor ?? '#cbd5e1' }}
                        />
                        {table.zoneName ?? table.zone} · {table.seats} seat{table.seats === 1 ? '' : 's'}
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${meta.pill}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.pillDot}`} />
                      {meta.label}
                    </span>
                  </div>

                  {openOrders.length > 0 ? (
                    <div className="mt-3 text-xs text-foreground flex items-center gap-1.5">
                      <span className="font-bold text-base">{openOrders.length}</span>
                      <span className="text-muted-foreground">open order{openOrders.length > 1 ? 's' : ''} ·</span>
                      <span className="font-extrabold text-gradient">{fmtMoney(total)}</span>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-muted-foreground italic">No open orders</div>
                  )}

                  {table.reservations && table.reservations.length > 0 ? (
                    <div className="mt-2 text-[11px] px-2 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200">
                      Next booking:{' '}
                      <span className="font-bold">
                        {new Date(table.reservations[0].startAt).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  ) : null}

                  <div
                    className="mt-3 flex flex-wrap gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px] lift-on-hover"
                      onClick={() => openEdit(table)}
                    >
                      <Pencil className="w-3 h-3 mr-1" /> Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-[11px] lift-on-hover"
                      onClick={() => toggleOutOfService(table)}
                    >
                      <PowerOff className="w-3 h-3 mr-1" />
                      {table.status === 'out_of_service' ? 'Reactivate' : 'OOS'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px] text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                      onClick={() => setArchiveTarget(table)}
                    >
                      <Archive className="w-3 h-3 mr-1" /> Archive
                    </Button>
                    {(() => {
                      const order = zoneOrders.get(table.zone) ?? [];
                      const zi = order.indexOf(table.id);
                      const first = zi <= 0;
                      const last = zi < 0 || zi >= order.length - 1;
                      return (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0 lift-on-hover"
                            disabled={first}
                            title="Move up — toward the front of the picker"
                            onClick={() => moveTable(table, 'up')}
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0 lift-on-hover"
                            disabled={last}
                            title="Move down — toward the back of the picker"
                            onClick={() => moveTable(table, 'down')}
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      );
                    })()}
                  </div>
                </CardContent>
                {/* Decorative chevron on hover */}
                <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground/30 opacity-0 group-hover:opacity-100 group-hover:translate-x-0 -translate-x-2 transition-all" />
              </Card>
            );
            })}
              </div>
            </div>
          );
        })
      )}

      {/* ── Create / Edit dialog (shared) ── */}
      <Dialog
        open={createOpen || !!editTarget}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false);
            setEditTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editTarget ? `Edit T${editTarget.number}` : 'Create table'}</DialogTitle>
            <DialogDescription>
              Geometry, layout, and operational metadata. The Floor Plan editor
              will read these fields in the next iteration.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Table 1"
              />
            </Field>
            <Field label="Number">
              <Input
                type="number"
                value={form.number}
                onChange={(e) => setForm((f) => ({ ...f, number: e.target.value }))}
                placeholder="1"
              />
            </Field>
            <Field label="Seats">
              <Input
                type="number"
                value={form.seats ?? 2}
                onChange={(e) => setForm((f) => ({ ...f, seats: Number(e.target.value) }))}
                min={0}
              />
            </Field>
            <Field label="Zone">
              <select
                className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
                value={form.zone}
                onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value as PosTableZone }))}
              >
                {/* Keep the table's current zone selectable even when its key is
                    not in the catalog (archived zone / zones still loading) —
                    otherwise the select shows blank and saving silently resets
                    the zone to the first option. */}
                {form.zone && !zones.some((z) => z.key === form.zone) && (
                  <option value={form.zone}>{editTarget?.zoneName ?? form.zone}</option>
                )}
                {sortZones(zones.filter((z) => z.active)).map((z) => (
                  <option key={z.key} value={z.key}>
                    {z.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Shape">
              <select
                className="h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
                value={form.shape}
                onChange={(e) => setForm((f) => ({ ...f, shape: e.target.value as PosTableShape }))}
              >
                {SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Active" className="col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active ?? true}
                  onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                />
                Show in picker
              </label>
            </Field>
            <Field label="Sort Order">
              <Input
                type="number"
                value={form.sortOrder ?? 0}
                onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
              />
            </Field>
            <Field label="QR Code URL">
              <Input
                value={form.qrCodeUrl ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, qrCodeUrl: e.target.value }))}
                placeholder="https://menu.example.com/t/1"
              />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Input
                value={form.notes ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setCreateOpen(false); setEditTarget(null); }}>
              Cancel
            </Button>
            <Button
              onClick={editTarget ? submitEdit : submitCreate}
              disabled={create.isPending || update.isPending}
            >
              {editTarget ? 'Save changes' : 'Create table'}
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
            <AlertDialogTitle>Archive T{archiveTarget?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              The table is hidden from the picker but its history (orders,
              reservations, audit) is kept. Reactivation is done from the DB
              (or by editing <code>active=true</code> in the API).
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

      {/* ── Detail dialog (drill-in for open orders + history) ── */}
      <TableDetailDialog
        table={viewTarget}
        onClose={() => setViewTarget(null)}
        onEdit={(t) => {
          setViewTarget(null);
          openEdit(t);
        }}
      />

    </div>
  );
};

const Field: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({
  label,
  className,
  children,
}) => (
  <div className={className}>
    <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1">
      {label}
    </label>
    {children}
  </div>
);

const CalendarPlusIcon = () => (
  <svg className="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="12" y1="14" x2="12" y2="20" />
    <line x1="9"  y1="17" x2="15" y2="17" />
  </svg>
);

const BarChart3Icon = () => (
  <svg className="w-4 h-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" />
    <path d="M7 12l4-4 4 4 5-5" />
  </svg>
);

export default TablesPage;