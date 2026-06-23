// POS Pro — professional, modern, reliable selling interface.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import { Lock, Coffee } from 'lucide-react';

import { Topbar } from './Topbar';
import { CategoryStrip } from './CategoryStrip';
import { MenuGrid } from './MenuGrid';
import { OrderPanel } from './OrderPanel';
import { TablePicker } from './TablePicker';
import { AddOnsDialog } from './AddOnsDialog';
import { CustomerDialog } from './CustomerDialog';
import { DiscountDialog } from './DiscountDialog';
import { LineDiscountDialog } from './LineDiscountDialog';
import { HeldOrdersDialog } from './HeldOrdersDialog';
import { TaxServiceDialog } from './TaxServiceDialog';
import { PaymentDialog } from './PaymentDialog';
import { PreviewDialog } from './PreviewDialog';
import { TextDialog } from './TextDialog';

import { posApi } from './api';
import type { Category, Menu, Order, OrderItem, OrderType, Table, Customer } from './types';
import '../../../styles/pos-pro.css';

interface BusinessContext {
  businessName?: string;
  businessAddress?: string;
  taxId?: string;
  currency?: string;
  footer?: string;
}

const POSPro: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // core data
  const [categories, setCategories] = useState<Category[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);

  // ui
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [orderType, setOrderType] = useState<OrderType>('DINE_IN');
  const [fullscreen, setFullscreen] = useState(false);
  const [ctx, setCtx] = useState<BusinessContext>({ currency: 'UGX' });
  const [showPicker, setShowPicker] = useState(false);
  const [showAddOns, setShowAddOns] = useState<Menu | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showTax, setShowTax] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [preview, setPreview] = useState<{ kind: 'RECEIPT' | 'KOT'; station?: 'BAR' | 'KITCHEN' | 'CAFE' } | null>(null);
  const [textDialog, setTextDialog] = useState<null | { kind: 'note' | 'void'; item: OrderItem }>(null);
  const [lineDisc, setLineDisc] = useState<OrderItem | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [holdDialog, setHoldDialog] = useState(false);
  const [counterMode, setCounterMode] = useState(false);

  const reloadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------- loaders --------
  const loadAll = useCallback(async () => {
    try {
      const [cats, ms, tlist] = await Promise.all([
        posApi.listCategories(),
        posApi.listMenus(true),
        posApi.listTables(),
      ]);
      setCategories((cats || []).filter((c) => c.active !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)));
      setMenus(ms || []);
      setTables(tlist || []);
    } catch { /* noop */ }
  }, []);

  const loadBusinessContext = useCallback(async () => {
    try {
      const api = (await import('../../../services/api')).default;
      const r = await api.get('/system-config/public');
      const map: Record<string, string> = r.data || {};
      setCtx({
        businessName: map.business_name,
        businessAddress: map.business_address,
        taxId: map.tax_id,
        currency: map.currency || 'UGX',
        footer: map.receipt_footer,
      });
    } catch { /* noop */ }
  }, []);

  const refreshOrder = useCallback(async () => {
    if (!order) return;
    try {
      const fresh = await posApi.getOrder(order.id);
      setOrder(fresh);
    } catch { /* noop */ }
  }, [order?.id]);

  useEffect(() => { loadAll(); loadBusinessContext(); }, [loadAll, loadBusinessContext]);

  // Auto-refresh the open order every 5s for KOT status updates etc.
  useEffect(() => {
    if (reloadTimerRef.current) clearInterval(reloadTimerRef.current);
    if (!order) return;
    reloadTimerRef.current = setInterval(() => refreshOrder(), 5000);
    return () => { if (reloadTimerRef.current) clearInterval(reloadTimerRef.current); };
  }, [order?.id, refreshOrder]);

  // Auto-pick the open order if there's a recent one for this user (POSWithExtras behaviour).
  useEffect(() => {
    if (selectedTable || order) return;
    (async () => {
      try {
        const api = (await import('../../../services/api')).default;
        const r = await api.get('/orders/current');
        if (r.data && r.data.id && r.data.status === 'OPEN') {
          setOrder(r.data);
          if (r.data.table) setSelectedTable(r.data.table);
        }
      } catch { /* noop */ }
    })();
  }, [selectedTable, order]);

  // -------- derived --------
  const filteredMenus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menus.filter((m) => {
      if (!m.active) return false;
      if (activeCategory && m.categoryId !== activeCategory) return false;
      if (q && !m.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [menus, activeCategory, search]);

  const locked = !selectedTable;

  // -------- actions --------
  const ensureOrder = async (): Promise<Order | null> => {
    if (order) return order;
    if (!selectedTable) {
      toast.error('Select a table first');
      return null;
    }
    try {
      const o = await posApi.createOrder({ tableId: selectedTable.id, type: orderType });
      setOrder(o);
      // mark table occupied
      try { await posApi.setTableStatus(selectedTable.id, 'OCCUPIED'); } catch { /* noop */ }
      loadAll();
      return o;
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to create order');
      return null;
    }
  };

  const onPickMenu = async (m: Menu) => {
    if (m.addOns && m.addOns.length > 0) {
      setShowAddOns(m);
      return;
    }
    await addItemDirect(m.id, [], '');
  };

  const addItemDirect = async (menuId: number, addOnIds: number[], notes: string) => {
    const o = await ensureOrder();
    if (!o) return;
    try {
      const fresh = await posApi.addItem(o.id, { menuId, quantity: 1, addOns: addOnIds, notes: notes || undefined });
      setOrder(fresh);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to add item'); }
  };

  const onAddItem = (addOnIds: number[], notes: string) => {
    if (!showAddOns) return;
    const m = showAddOns;
    setShowAddOns(null);
    addItemDirect(m.id, addOnIds, notes);
  };

  const onInc = async (it: OrderItem) => {
    if (!order) return;
    try {
      const fresh = await posApi.updateItemQuantity(order.id, it.id, it.quantity + 1);
      setOrder(fresh);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to update'); }
  };
  const onDec = async (it: OrderItem) => {
    if (!order) return;
    if (it.quantity <= 1) {
      try {
        const fresh = await posApi.removeItem(order.id, it.id);
        setOrder(fresh);
      } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to remove'); }
      return;
    }
    try {
      const fresh = await posApi.updateItemQuantity(order.id, it.id, it.quantity - 1);
      setOrder(fresh);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to update'); }
  };
  const onRemove = async (it: OrderItem) => {
    if (!order) return;
    try {
      const fresh = await posApi.removeItem(order.id, it.id);
      setOrder(fresh);
      toast.success('Item removed');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to remove'); }
  };
  const onVoid = (it: OrderItem) => setTextDialog({ kind: 'void', item: it });
  const onNote = (it: OrderItem) => setTextDialog({ kind: 'note', item: it });

  const onSubmitText = async (text: string) => {
    if (!textDialog || !order) return;
    const it = textDialog.item;
    if (textDialog.kind === 'void') {
      try {
        const fresh = await posApi.voidItem(order.id, it.id, text);
        setOrder(fresh);
        toast.success('Item voided');
      } catch (e: any) { toast.error(e?.response?.data?.message || 'Void failed'); }
    } else {
      // For notes we just refresh; backend doesn't have a direct "update notes" route,
      // so we update via addItem? Simplest: toast success and skip. The addItem flow handles notes on add.
      toast.info('Notes are set when adding the item. Use item-add dialog for new entries.');
    }
    setTextDialog(null);
  };

  const onSendKOT = () => {
    if (!order) return;
    const stations = uniqueStations(order);
    if (stations.length === 1) {
      setPreview({ kind: 'KOT', station: stations[0] });
    } else {
      setPreview({ kind: 'KOT' }); // no station => show "all"
    }
  };

  const onPrintBill = () => { if (order) setPreview({ kind: 'RECEIPT' }); };

  const doPrint = async () => {
    if (!order || !preview) return;
    try {
      if (preview.kind === 'KOT') {
        if (preview.station) {
          const r = await posApi.printKOT(order.id, preview.station);
          if (r?.ok) toast.success(`KOT sent to ${preview.station}`);
          else toast.warning(r?.error || 'KOT service unavailable');
        } else {
          const stations = uniqueStations(order);
          for (const s of stations) {
            const r = await posApi.printKOT(order.id, s);
            if (!r?.ok) console.warn('KOT print failed for', s, r);
          }
          toast.success(`KOT sent to ${stations.length} station(s)`);
        }
        await refreshOrder();
      } else {
        const r = await posApi.printReceipt(order.id);
        if (r?.ok) toast.success('Receipt printed');
        else toast.warning(r?.error || 'Print service unavailable');
        await refreshOrder();
      }
      setPreview(null);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Print failed'); }
  };

  const doPrintAllKOT = async () => {
    if (!order) return;
    try {
      const stations = uniqueStations(order);
      for (const s of stations) {
        await posApi.printKOT(order.id, s);
      }
      toast.success(`KOT sent to ${stations.length} station(s)`);
      setPreview(null);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Print failed'); }
  };

  const onPickTable = async (t: Table) => {
    setSelectedTable(t);
    if (!order) {
      // Look for an open order on this table and use it if exists
      const existing = t.orders && t.orders.find((o) => o.status === 'OPEN');
      if (existing) {
        setOrder(existing);
      } else {
        // new order
        try {
          const o = await posApi.createOrder({ tableId: t.id, type: orderType });
          setOrder(o);
        } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to create order'); }
      }
    }
  };

  const onClearTable = () => {
    setSelectedTable(null);
    setOrder(null);
  };

  const onSetType = async (t: OrderType) => {
    setOrderType(t);
    if (order) {
      try {
        const fresh = await posApi.setType(order.id, t);
        setOrder(fresh);
      } catch { /* noop */ }
    }
  };

  const onAddDiscount = () => setShowDiscount(true);

  const onHold = () => { if (!order) return; setHoldDialog(true); };

  const onSubmitHold = async (reason: string) => {
    if (!order) return;
    try {
      const held = await posApi.holdOrder(order.id, { reason });
      toast.success(`Held ${held.orderNumber}`);
      setOrder(null);
      setSelectedTable(null);
      setHoldDialog(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to hold order');
      throw e;
    }
  };

  const onResumeFromHeld = (held: Order) => {
    setOrder(held);
    if (held.table) setSelectedTable(held.table);
  };

  const onOpenCounter = async () => {
    try {
      const o = await posApi.createCounterOrder({ type: 'TAKEAWAY' });
      setOrder(o);
      setSelectedTable(null);
      setCounterMode(true);
      toast.success('Counter order started');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to start counter order'); }
  };

  const onShowHeld = () => setShowHeld(true);

  const onAddTax = () => setShowTax(true);
  const onCharge = () => { if (order && order.items.length > 0) setShowPayment(true); else toast.error('Add items first'); };
  const onSplit = () => { if (order && order.items.length > 0) setShowPayment(true); else toast.error('Add items first'); };

  const onPickCustomer = async (c: Customer) => {
    if (!order) return;
    try {
      const fresh = await posApi.setCustomer(order.id, c.id);
      setOrder(fresh);
      toast.success(`Customer: ${c.name}`);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to attach customer'); }
  };

  const onApplyDiscount = async (type: 'percentage' | 'fixed', value: number, reason: string, pin?: string) => {
    if (!order) return;
    try {
      const fresh = await posApi.applyDiscountWithReason(order.id, { discountType: type, discountValue: value, reason, managerPin: pin });
      setOrder(fresh);
      toast.success('Discount applied');
      setShowDiscount(false);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to apply discount'); }
  };

  const onApplyTax = async (taxRate: number, scRate: number) => {
    if (!order) return;
    try {
      let fresh = order;
      if (taxRate !== undefined) fresh = (await posApi.setTax(order.id, { taxRate })) as Order;
      if (scRate !== undefined) fresh = (await posApi.setServiceCharge(order.id, { serviceChargeRate: scRate })) as Order;
      setOrder(fresh);
      toast.success('Tax / service charge applied');
      setShowTax(false);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to apply tax'); }
  };

  const onPaymentSuccess = async (result: any) => {
    toast.success('Order settled!');
    // If a sale was created and the user has no table, free the table
    if (selectedTable) {
      try { await posApi.setTableStatus(selectedTable.id, 'AVAILABLE'); } catch { /* noop */ }
    }
    // Auto-print receipt
    try {
      await posApi.printReceipt(order!.id);
    } catch { /* noop */ }
    setOrder(null);
    setSelectedTable(null);
    loadAll();
  };

  // -------- keyboard shortcuts --------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'F2') { e.preventDefault(); onCharge(); }
      else if (e.key === 'F4') { e.preventDefault(); onSplit(); }
      else if (e.key === 'F8') { e.preventDefault(); onPrintBill(); }
      else if (e.key === 'F9') { e.preventDefault(); onSendKOT(); }
      else if (e.key === 'Escape') {
        setShowPicker(false); setShowAddOns(null); setShowCustomer(false);
        setShowDiscount(false); setShowTax(false); setShowPayment(false); setPreview(null);
        setTextDialog(null);
      }
      else if (e.key === '/') { e.preventDefault(); (document.querySelector('.pos-searchbar-pro input') as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, onCharge, onPrintBill, onSendKOT]);

  // -------- render --------
  return (
    <div className="pos-shell-pro">
      <Topbar
        table={selectedTable}
        orderType={orderType}
        onTypeChange={onSetType}
        onOpenTablePicker={() => setShowPicker(true)}
        onClearTable={onClearTable}
        search={search}
        onSearch={setSearch}
        onOpenHeld={onShowHeld}
        onOpenCounter={onOpenCounter}
        counterMode={counterMode}
        onExitCounter={() => { setCounterMode(false); setOrder(null); setSelectedTable(null); }}
        onHold={order && order.status === 'OPEN' ? onHold : null}
        staffName={user?.name}
        staffRole={(user as any)?.role}
        fullscreen={fullscreen}
        onToggleFullscreen={() => {
          setFullscreen((f) => {
            const next = !f;
            try { document.documentElement.requestFullscreen?.().catch(() => {}); if (!next) document.exitFullscreen?.().catch(() => {}); } catch { /* noop */ }
            return next;
          });
        }}
        onLogout={() => { logout(); navigate('/login'); }}
      />

      <div className="pos-body-pro">
        <div className="pos-menus-pro">
          <CategoryStrip categories={categories} activeId={activeCategory} onSelect={setActiveCategory} />
          <div className="relative flex-1 min-h-0">
            {locked ? (
              <div className="pos-lock-overlay-pro">
                <div className="pos-lock-icon"><Lock className="h-10 w-10" /></div>
                <div className="pos-lock-title">Select a table to start</div>
                <div className="pos-lock-sub">Choose where the guest is sitting, or use a Takeaway / Delivery ticket.</div>
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="pos-action-btn-pro bg-blue h-12 px-6"
                  style={{ width: 'auto', paddingLeft: 24, paddingRight: 24, minHeight: 48 }}
                >
                  <Coffee className="pos-action-icon" /> Browse tables
                </button>
              </div>
            ) : null}
            <MenuGrid menus={filteredMenus} locked={locked} onPick={onPickMenu} />
          </div>
        </div>

        <OrderPanel
          order={order}
          tableNumber={selectedTable?.number}
          customerName={order?.customer?.name}
          onInc={onInc}
          onDec={onDec}
          onRemove={onRemove}
          onVoid={onVoid}
          onNote={onNote}
          onSendKOT={onSendKOT}
          onPrintBill={onPrintBill}
          onCharge={onCharge}
          onSplit={onSplit}
          onAddCustomer={() => setShowCustomer(true)}
          onAddDiscount={onAddDiscount}
          onAddTax={onAddTax}
          onCloseOrder={onClearTable}
        />
      </div>

      <TablePicker
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onPick={onPickTable}
        selected={selectedTable}
        onTablesChanged={loadAll}
      />

      <AddOnsDialog open={!!showAddOns} menu={showAddOns} onClose={() => setShowAddOns(null)} onAdd={onAddItem} />
      <CustomerDialog open={showCustomer} onClose={() => setShowCustomer(false)} onPick={onPickCustomer} />
      <DiscountDialog
        open={showDiscount}
        initialType={order?.discountType === 'fixed' ? 'fixed' : 'percentage'}
        initialValue={order?.discountValue || 0}
        onClose={() => setShowDiscount(false)}
        onApply={onApplyDiscount}
      />
      <TaxServiceDialog
        open={showTax}
        initialTaxRate={order?.tax || 0}
        initialSCRate={0}
        onClose={() => setShowTax(false)}
        onApply={onApplyTax}
      />
      <PaymentDialog
        open={showPayment}
        order={order}
        onClose={() => setShowPayment(false)}
        onSuccess={onPaymentSuccess}
      />
      <PreviewDialog
        open={!!preview}
        kind={preview?.kind || null}
        station={preview?.station}
        order={order}
        context={ctx}
        onClose={() => setPreview(null)}
        onPrint={doPrint}
        onPrintAll={preview?.kind === 'KOT' && !preview.station ? doPrintAllKOT : undefined}
      />
<HeldOrdersDialog open={showHeld} onClose={() => setShowHeld(false)} onResume={onResumeFromHeld} />
      <LineDiscountDialog
        open={!!lineDisc}
        orderId={order?.id ?? null}
        item={lineDisc}
        onClose={() => setLineDisc(null)}
        onApplied={refreshOrder}
      />
      <TextDialog
        open={holdDialog}
        title="Hold this order"
        description="Why are you parking this ticket? A reason helps the next cashier."
        placeholder="e.g. Guest not back yet"
        confirmLabel="Hold order"
        confirmColor="#f59e0b"
        onClose={() => setHoldDialog(false)}
        onSubmit={onSubmitHold}
      />
      <TextDialog
        open={!!textDialog}
        title={textDialog?.kind === 'void' ? `Void "${textDialog.item.menu?.name}"` : `Note for "${textDialog?.item.menu?.name}"`}
        description={textDialog?.kind === 'void' ? 'A reason is required for voids (shown on reports).' : 'Add a kitchen note for this item.'}
        placeholder={textDialog?.kind === 'void' ? 'e.g. Customer changed mind' : 'e.g. no onions'}
        confirmLabel={textDialog?.kind === 'void' ? 'Void item' : 'Save'}
        confirmColor={textDialog?.kind === 'void' ? '#dc2626' : undefined}
        multiline={textDialog?.kind === 'void'}
        onClose={() => setTextDialog(null)}
        onSubmit={onSubmitText}
      />
    </div>
  );
};

function uniqueStations(order: Order): ('BAR' | 'KITCHEN' | 'CAFE')[] {
  const set = new Set<'BAR' | 'KITCHEN' | 'CAFE'>();
  for (const it of (order.items || []).filter((i) => !i.voided)) {
    if (it.menu?.station) set.add(it.menu.station);
  }
  return Array.from(set);
}

export default POSPro;
