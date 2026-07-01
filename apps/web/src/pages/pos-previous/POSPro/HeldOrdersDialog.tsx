// Drawer of parked (HELD) orders, with a one-tap "Resume" action.
import React, { useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, Clock, Hash, User as UserIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { posApi } from './api';
import type { Order } from './types';

const fmt = (n: number) => `UGX ${Number(n || 0).toLocaleString()}`;

interface Props {
  open: boolean;
  onClose: () => void;
  onResume: (order: Order) => void;
}

export const HeldOrdersDialog: React.FC<Props> = ({ open, onClose, onResume }) => {
  const [list, setList] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setList(await posApi.listHeldOrders()); } catch { /* noop */ }
    setLoading(false);
  };
  useEffect(() => { if (open) load(); }, [open]);

  const resume = async (o: Order) => {
    try {
      setBusy(true);
      const fresh = await posApi.resumeOrder(o.id);
      toast?.success?.(`Resumed ${fresh.orderNumber}`);
      onResume(fresh);
      onClose();
    } catch (e: any) {
      toast?.error?.(e?.response?.data?.message || 'Failed to resume');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[640px] p-0 overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-amber-500 to-amber-700 text-white p-4">
          <DialogTitle className="text-white text-base font-bold flex items-center gap-2">
            <Pause className="h-4 w-4" /> Held / parked orders
          </DialogTitle>
          <DialogDescription className="text-amber-100 text-xs">
            Pick a parked ticket to resume it. The original table (if any) is kept.
          </DialogDescription>
        </DialogHeader>
        <div className="p-3 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <p className="text-center text-slate-500 py-6">Loading…</p>
          ) : list.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <Pause className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="font-semibold">No held orders</p>
              <p className="text-xs mt-1">Held tickets will show here so you can resume them later.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {list.map((o) => {
                const itemCount = (o.items || []).filter((i) => !i.voided).length;
                const heldAgo = o.heldAt ? new Date(o.heldAt) : null;
                const mins = heldAgo ? Math.floor((Date.now() - heldAgo.getTime()) / 60000) : 0;
                return (
                  <div key={o.id} className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white hover:border-amber-400 transition-colors">
                    <div className="w-10 h-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
                      <Pause className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm flex items-center gap-2">
                        <Hash className="h-3 w-3 text-slate-400" />
                        {o.orderNumber}
                        {o.table ? <span className="text-xs text-slate-500">· T{o.table.number}</span> : null}
                        {o.source && o.source !== 'TABLE' ? (
                          <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">{o.source}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-3 mt-0.5">
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{mins}m ago</span>
                        <span>{itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                        <span className="font-mono font-bold text-amber-600">{fmt(o.total)}</span>
                        {o.heldByUser ? <span className="flex items-center gap-1"><UserIcon className="h-3 w-3" />{o.heldByUser.name}</span> : null}
                      </div>
                      {o.holdReason ? <div className="text-xs text-slate-600 italic mt-1">"{o.holdReason}"</div> : null}
                    </div>
                    <Button onClick={() => resume(o)} disabled={busy} style={{ background: '#16a34a' }}>
                      <Play className="h-4 w-4 mr-1" /> Resume
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-slate-200 p-3 bg-slate-50">
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
