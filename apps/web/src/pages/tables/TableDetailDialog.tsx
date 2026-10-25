/**
 * Tables detail dialog — opened from the TablesPage grid. Shows open
 * orders, recent history, and exposes merge / transfer / split actions.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRightLeft,
  Link2,
  Unlink,
  Scissors,
  Pencil,
  Receipt,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTable, useTables, useMergeTables, useTransferTable, useUnmergeTable, useSplitBill } from '@/features/tables/api';
import { api } from '@/lib/api';
import type { PosTable } from '@/features/tables/types';
import { statusMeta, fmtMoney, minutesBetween } from '@/features/tables/utils';
import { tx } from '@/lib/i18n/tx';

// Release 2026-09-r2 finding F8. Re-enable once the endpoint is fixed.
const TABLES_PAGE_SPLIT_ENABLED = false;

interface Props {
  table: PosTable | null;
  onClose: () => void;
  onEdit: (t: PosTable) => void;
}

export const TableDetailDialog: React.FC<Props> = ({ table, onClose, onEdit }) => {
  const id = table?.id ?? null;
  const { data: fresh } = useTable(id);
  const { data: allTables = [] } = useTables({ active: true });
  const merge = useMergeTables();
  const unmerge = useUnmergeTable();
  const transfer = useTransferTable();
  const split = useSplitBill();

  const otherTables = useMemo(
    () => allTables.filter((t) => t.id !== id && !t.mergedIntoId && t.active && t.status !== 'out_of_service'),
    [allTables, id],
  );

  const [targetId, setTargetId] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSource, setSplitSource] = useState<string>('');

  useEffect(() => {
    setTargetId('');
    setSplitOpen(false);
  }, [id]);

  const t = fresh ?? table;
  if (!t) return null;
  const meta = statusMeta(t.status);
  const openOrders = (t.orders ?? []).filter((o) => !o.closedAt);
  const total = openOrders.reduce((s, o) => s + Number(o.order?.totalAmount ?? 0), 0);

  async function doMerge() {
    if (!targetId || !t) return;
    try {
      await merge.mutateAsync({ sourceId: t.id, targetId });
      toast.success(tx('Tables merged'));
      setTargetId('');
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Merge failed');
    }
  }

  async function doUnmerge() {
    if (!t) return;
    try {
      await unmerge.mutateAsync(t.id);
      toast.success(tx('Unmerged'));
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Unmerge failed');
    }
  }

  async function doTransfer() {
    if (!targetId || !t) return;
    try {
      await transfer.mutateAsync({ sourceId: t.id, targetId });
      toast.success(tx('Open orders transferred'));
      setTargetId('');
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Transfer failed');
    }
  }

  async function doSplit() {
    if (!t || !splitSource) return;
    try {
      const { data: doc } = await api.get(`/pos/tabs/${t.id}`);
      if (!doc?.lines?.length) { toast.error(tx('Source document has no lines')); return; }
      const lines: Array<{ id: string; quantity: number }> = doc.lines;
      const split1: Array<{ sourceItemId: string; quantity: number }> = [];
      const split2: Array<{ sourceItemId: string; quantity: number }> = [];
      for (const ln of lines) {
        const qty = Math.floor(Number(ln.quantity));
        const half = Math.ceil(qty / 2);
        if (half > 0 && qty - half > 0) {
          split1.push({ sourceItemId: ln.id, quantity: half });
          split2.push({ sourceItemId: ln.id, quantity: qty - half });
        } else {
          split2.push({ sourceItemId: ln.id, quantity: qty });
        }
      }
      if (split1.length === 0) { toast.error(tx('Cannot split — each line quantity is 1')); return; }
      await split.mutateAsync({
        tableId: t.id,
        body: {
          sourceOrderId: splitSource,
          splits: [
            { label: 'Split 1', lines: split1 },
            { label: 'Split 2', lines: split2 },
          ],
        },
      });
      toast.success(tx('Bill split into two tickets'));
      setSplitOpen(false);
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Split failed');
    }
  }

  return (
    <Dialog open={!!table} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-slate-500 text-sm font-bold">T{t.number}</span>
            {t.name}
            <span
              className={`ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${meta.pill}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${meta.pillDot}`} />
              {meta.label}
            </span>
          </DialogTitle>
          <DialogDescription>
            {t.seats} {tx('seats ·')} {t.zoneName ?? t.zone}
            {t.mergedIntoId ? (
              <span className="ml-2 text-rose-600 font-bold">
                {tx('⚠ merged — use Unmerge before re-using')}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {/* Open orders */}
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            {tx('Open orders')}
          </h3>
          {openOrders.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-slate-400">{tx('No open orders')}</CardContent></Card>
          ) : (
            <div className="space-y-2">
              {openOrders.map((o) => (
                <Card key={o.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-extrabold">
                        #{o.order?.orderNumber ?? (o.orderId ? o.orderId.slice(0, 6) : '—')}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {o.customerName ?? 'Walk-in'}
                        {o.guestCount ? ` · ${o.guestCount} guests` : ''}
                        {' · '}
                        {tx('opened')} {minutesBetween(o.openedAt, null)}{tx('m ago')}
                      </div>
                    </div>
                    <div className="font-extrabold text-slate-700">
                      {fmtMoney(o.order?.totalAmount)}
                    </div>
                  </CardContent>
                </Card>
              ))}
              <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-100">
                <span>{tx('Total on table')}</span>
                <span>{fmtMoney(total)}</span>
              </div>
            </div>
          )}
        </section>

        {/* Reservations */}
        {t.reservations && t.reservations.length > 0 ? (
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              {tx('Upcoming reservations')}
            </h3>
            <div className="space-y-1.5">
              {t.reservations.slice(0, 5).map((r) => (
                <div
                  key={r.id}
                  className="text-xs text-slate-700 flex items-center justify-between border border-slate-100 rounded px-3 py-2 bg-blue-50/40"
                >
                  <div>
                    <span className="font-extrabold">{r.customerName}</span> · {r.partySize} pax
                  </div>
                  <div className="text-slate-500">
                    {new Date(r.startAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Actions */}
        <section className="border-t border-slate-100 pt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                {tx('Target table')}
              </label>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="h-10 w-full px-3 rounded-lg border border-input bg-white text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{tx('Select a table…')}</option>
                {otherTables.map((ot) => (
                  <option key={ot.id} value={ot.id}>
                    T{ot.number} {ot.name} · {ot.seats} {tx('seats ·')}{' '}
                    {ot.zoneName ?? ot.zone} ·{' '}
                     {statusMeta(ot.status).label}
                  </option>
                ))}
                {otherTables.length === 0 ? (
                  <option disabled>{tx('No other active tables available')}</option>
                ) : null}
              </select>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!targetId || merge.isPending}
                onClick={doMerge}
              >
                <Link2 className="w-3 h-3 mr-1" /> {tx('Merge')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!targetId || transfer.isPending}
                onClick={doTransfer}
              >
                <ArrowRightLeft className="w-3 h-3 mr-1" /> {tx('Transfer')}
              </Button>
              {t.mergedIntoId ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={doUnmerge}
                  disabled={unmerge.isPending}
                >
                  <Unlink className="w-3 h-3 mr-1" /> {tx('Unmerge')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Hidden: POST /pos/tables/:id/split-bill returns 409 (the split tabs
                violate the one-open-tab-per-table index). Split from the POS screen. */}
            {TABLES_PAGE_SPLIT_ENABLED ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSplitOpen(true)}
                disabled={openOrders.length === 0}
              >
                <Scissors className="w-3 h-3 mr-1" /> {tx('Split bill')}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => onEdit(t)}>
              <Pencil className="w-3 h-3 mr-1" /> {tx('Edit')}
            </Button>
          </div>
        </section>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="w-3 h-3 mr-1" /> {tx('Close')}
          </Button>
        </DialogFooter>

        {/* Split-bill inline prompt */}
        {splitOpen ? (
          <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
            <h4 className="text-sm font-bold text-amber-800">{tx('Split bill')}</h4>
            <select
              value={splitSource}
              onChange={(e) => setSplitSource(e.target.value)}
              className="h-9 px-3 rounded-md border border-amber-200 bg-white text-sm w-full"
            >
              <option value="">{tx('Select an open order…')}</option>
              {openOrders.map((o) => (
                <option key={o.id} value={o.orderId}>
                  #{o.order?.orderNumber ?? o.orderId.slice(0, 6)} ·{' '}
                  {fmtMoney(o.order?.totalAmount)}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-amber-700">
              {tx('Use the order panel\'s split controls for item-level splits. This quick action flags the chosen order for the split workflow.')}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSplitOpen(false)}>
                {tx('Cancel')}
              </Button>
              <Button size="sm" onClick={doSplit} disabled={!splitSource || split.isPending}>
                <Receipt className="w-3 h-3 mr-1" /> {tx('Initiate split')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

export default TableDetailDialog;