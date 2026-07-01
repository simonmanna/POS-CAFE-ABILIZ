// src/pages/pos/POSWithExtras.tsx
// Wraps the existing POSPage with a top action bar that exposes:
//   - Charge (opens the redesigned multi-tender dialog)
//   - Send to KOT
//   - Print receipt (real or fallback)
//   - Open tax / service-charge / discount editor
//   - Split-bill
//   - Refund (manager PIN)
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CreditCard, Printer, Scissors, Send, Lock, Settings, ChevronLeft, Maximize, Minimize, Wallet } from 'lucide-react';
import POSPage from './POSPage';
import QuickCashDialog from '../../components/cashflow/QuickCashDialog';
import MultiTenderDialog from '../../components/payments/MultiTenderDialog';

interface OrderLite {
  id: number; orderNumber: string; status: string; subtotal: number; discountAmount: number;
  taxAmount: number; serviceChargeAmount: number; total: number; items: any[];
}

const POSWithExtras: React.FC = () => {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const [order, setOrder] = useState<OrderLite | null>(null);
  const [taxOpen, setTaxOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [cashflowOpen, setCashflowOpen] = useState(false);
  const [taxRate, setTaxRate] = useState('0');
  const [scRate, setScRate] = useState('0');
  const [splitLines, setSplitLines] = useState<{ orderItemId: number; quantity: number; menuName: string }[]>([]);
  const [splitBills, setSplitBills] = useState<{ items: { orderItemId: number; quantity: number }[] }[]>([{ items: [] }, { items: [] }]);
  const [refundPin, setRefundPin] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [fullscreen, setFullscreen] = useState(false);

  // Poll /orders/current to discover the active order
  React.useEffect(() => {
    const tick = () => {
      api.get('/orders/current').then(r => {
        if (r.data && r.data.id) setOrder(r.data);
        else if (!r.data) setOrder(null);
      }).catch(() => {});
    };
    const t = setInterval(tick, 2500);
    tick();
    return () => clearInterval(t);
  }, []);

  const sendKOT = async () => {
    if (!order) return toast.error('No active order');
    try {
      const r = await api.post(`/print/kot/${order.id}`, {});
      toast.success(r?.data?.mode === 'pdf-fallback' ? 'KOT saved as PDF' : 'KOT sent to printer');
    } catch { toast.error('KOT failed'); }
  };

  const printReceipt = async () => {
    if (!order) return toast.error('No active order');
    try {
      const r = await api.post(`/print/receipt/${order.id}`);
      toast.success(r?.data?.mode === 'pdf-fallback' ? 'Receipt saved as PDF' : 'Receipt printed');
    } catch { toast.error('Receipt failed'); }
  };

  const openTax = () => {
    if (!order) return toast.error('No order');
    setTaxRate(String(((order.taxAmount / Math.max(0.0001, order.subtotal - order.discountAmount)) * 100).toFixed(2)));
    setScRate(String(((order.serviceChargeAmount / Math.max(0.0001, order.subtotal - order.discountAmount)) * 100).toFixed(2)));
    setTaxOpen(true);
  };

  const saveTax = async () => {
    if (!order) return;
    try {
      await api.put(`/orders/${order.id}/tax`, { taxRate: Number(taxRate) });
      await api.put(`/orders/${order.id}/service-charge`, { serviceChargeRate: Number(scRate) });
      const fresh = await api.get(`/orders/${order.id}`);
      setOrder(fresh.data);
      setTaxOpen(false);
      toast.success('Tax & service charge updated');
    } catch { toast.error('Update failed'); }
  };

  const openSplit = async () => {
    if (!order) return;
    try {
      const r = await api.get(`/orders/${order.id}`);
      const items = (r.data.items || []).filter((i: any) => !i.voided).map((i: any) => ({ orderItemId: i.id, quantity: i.quantity, menuName: i.menu.name }));
      setSplitLines(items);
      setSplitBills([{ items: items.map((i: any) => ({ orderItemId: i.orderItemId, quantity: 0 })) }, { items: items.map((i: any) => ({ orderItemId: i.orderItemId, quantity: 0 })) }]);
      setSplitOpen(true);
    } catch { toast.error('Could not open split-bill'); }
  };

  const submitSplit = async () => {
    if (!order) return;
    const totals: Record<number, number> = {};
    for (const b of splitBills) for (const it of b.items) totals[it.orderItemId] = (totals[it.orderItemId] || 0) + it.quantity;
    for (const orig of splitLines) if ((totals[orig.orderItemId] || 0) !== orig.quantity) return toast.error('Quantities must sum to original');
    try {
      const r = await api.post(`/payments/split-bill/${order.id}`, { splits: splitBills.filter(b => b.items.some(i => i.quantity > 0)) });
      toast.success(`Split into ${r.data.children.length} bills`);
      setSplitOpen(false);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Split failed'); }
  };

  const submitRefund = async () => {
    if (!order) return;
    if (!refundPin) return toast.error('Manager PIN required');
    try {
      const r = await api.get(`/orders/${order.id}`);
      const saleId = r.data.sale?.id;
      if (!saleId) return toast.error('Order has no completed sale yet');
      await api.post('/returns', {
        saleId, reason: refundReason, managerPin: refundPin, refundMethod: 'CASH',
        lines: (r.data.items || []).filter((i: any) => !i.voided).map((i: any) => ({ menuId: i.menuId, quantity: i.quantity })),
      });
      toast.success('Refund recorded');
      setRefundOpen(false);
      setRefundPin(''); setRefundReason('');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Refund failed'); }
  };

  return (
    <div className="relative h-full">
      {/* Floating action bar */}
      <div className="absolute right-3 top-3 z-50 flex gap-1 bg-white/90 backdrop-blur rounded-lg shadow p-1 print:hidden">
        <Button size="sm" variant="ghost" onClick={() => navigate('/')} title="Back to dashboard"><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={() => setFullscreen(f => !f)} title="Fullscreen">
          {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </Button>
        <Button size="sm" variant="ghost" onClick={sendKOT} title="Send KOT to printer"><Send className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={printReceipt} title="Print receipt"><Printer className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={openTax} title="Tax & service charge"><Settings className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" onClick={openSplit} title="Split bill"><Scissors className="h-4 w-4" /></Button>
        {hasRole('ADMIN', 'CASHIER', 'BARISTA') && (
          <Button size="sm" variant="ghost" onClick={() => setCashflowOpen(true)} title="Cash In / Out"><Wallet className="h-4 w-4" /></Button>
        )}
        {hasRole('ADMIN', 'CASHIER') && (
          <Button size="sm" variant="ghost" onClick={() => setRefundOpen(true)} title="Refund (manager PIN)"><Lock className="h-4 w-4" /></Button>
        )}
        {order && (
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500 text-white" onClick={() => setChargeOpen(true)} title="Charge">
            <CreditCard className="h-4 w-4 mr-1" /> Charge
          </Button>
        )}
      </div>

      <POSPage />

      {/* Multi-tender charge dialog */}
      {order && (
        <MultiTenderDialog
          open={chargeOpen}
          onClose={() => setChargeOpen(false)}
          orderId={order.id}
          total={order.total}
          onSettled={(r) => {
            setOrder(null);
            // Send KOT and print receipt automatically
            api.post(`/print/kot/${r.id}`).catch(() => {});
          }}
        />
      )}

      {/* Tax / Service Charge dialog */}
      <Dialog open={taxOpen} onOpenChange={setTaxOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Tax & Service Charge</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Tax rate (%)</Label><Input type="number" value={taxRate} onChange={e => setTaxRate(e.target.value)} /></div>
            <div><Label>Service charge (%)</Label><Input type="number" value={scRate} onChange={e => setScRate(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTaxOpen(false)}>Cancel</Button>
            <Button onClick={saveTax}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Split-bill dialog */}
      <Dialog open={splitOpen} onOpenChange={setSplitOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Split bill into multiple payments</DialogTitle></DialogHeader>
          <p className="text-sm text-slate-500">Allocate quantities across the bills. Totals must sum to the original order.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {splitBills.map((b, billIdx) => (
              <div key={billIdx} className="border rounded p-2">
                <div className="font-semibold mb-1">Bill {billIdx + 1}</div>
                {splitLines.map(orig => {
                  const cur = b.items.find(i => i.orderItemId === orig.orderItemId)?.quantity || 0;
                  return (
                    <div key={orig.orderItemId} className="grid grid-cols-[1fr_80px] items-center gap-1 py-0.5 text-sm">
                      <span>{orig.menuName} <span className="text-slate-400">({orig.quantity})</span></span>
                      <Input type="number" min={0} max={orig.quantity} value={cur}
                        onChange={e => {
                          const v = Math.min(orig.quantity, Math.max(0, Number(e.target.value) || 0));
                          setSplitBills(prev => prev.map((p, i) => i === billIdx ? { items: p.items.map(it => it.orderItemId === orig.orderItemId ? { ...it, quantity: v } : it) } : p));
                        }} className="h-7" />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setSplitBills(b => [...b, { items: splitLines.map(i => ({ orderItemId: i.orderItemId, quantity: 0 })) }])}>+ Add bill</Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSplitOpen(false)}>Cancel</Button>
              <Button onClick={submitSplit}>Split & create bills</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cashflow quick entry */}
      <QuickCashDialog
        open={cashflowOpen}
        onClose={() => setCashflowOpen(false)}
        defaultType="IN"
        onCreated={() => { /* POS doesn't need the new entry */ }}
      />

      {/* Refund dialog */}
      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Refund entire order</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div><Label>Reason</Label><Textarea rows={2} value={refundReason} onChange={e => setRefundReason(e.target.value)} /></div>
            <div><Label>Manager PIN</Label><Input type="password" value={refundPin} onChange={e => setRefundPin(e.target.value)} placeholder="Re-auth required" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)}>Cancel</Button>
            <Button onClick={submitRefund} variant="destructive">Issue refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default POSWithExtras;
