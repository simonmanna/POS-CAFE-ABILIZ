/**
 * Terminal — Cafe POS orchestrator.
 *
 * Stitches together: Topbar + CategoryStrip + MenuGrid + OrderPanel + dialogs
 * + cart store + the new backend endpoints (checkout, holds, override, X/Z).
 *
 * Flow:
 *   1. Cashier opens shift (ShiftOpenDialog) — required to start selling.
 *   2. Search by name OR scan barcode (auto-lookup on Enter in the topbar).
 *   3. Tap products to add to cart. Cart has line discounts, transaction
 *      discounts (override-gated), and per-line notes.
 *   4. Press Charge → PaymentDialog → multi-tender → POST /pos/checkout
 *      with idempotency key. Backend creates invoice + payments + stock-out
 *      atomically; cart clears on success.
 *   5. Press Hold → POST /pos/holds → cart is parked, can be recalled later.
 *   6. Press Reports → /pos/reports (X/Z + hourly + top-items).
 *   7. Press Close shift → variance report + Z-report.
 *
 * Permissions-aware: if the cashier doesn't have pos:discount, the discount
 * buttons are hidden. If they don't have pos:reports, the Reports button is
 * hidden.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Coffee, LayoutGrid, Users, ArrowLeft } from 'lucide-react';
import { Lock as LockIcon } from 'lucide-react';

import { Topbar } from './Topbar';
import { OfflineIndicator } from './OfflineIndicator';
import { enqueueSale } from '@/features/pos/offline-queue';
import { AddOnsDialog } from './AddOnsDialog';
import { CategoryStrip } from './CategoryStrip';
import { MenuGrid } from './MenuGrid';
import { OrderPanel } from './OrderPanel';
import { PaymentDialog } from './PaymentDialog';
import { DiscountDialog } from './DiscountDialog';
import { LineDiscountDialog } from './LineDiscountDialog';
import { CustomerDialog } from './CustomerDialog';
import { OverrideDialog } from './OverrideDialog';
import { ShiftOpenDialog } from './ShiftOpenDialog';
import { ShiftCloseDialog } from './ShiftCloseDialog';
import { ReceiptPreview, type ReceiptLine } from './ReceiptPreview';
import { TableSelectorDialog } from './TableSelectorDialog';
import { SplitBillDialog } from './SplitBillDialog';
import { VoidItemDialog } from './VoidItemDialog';
import { CancelOrderDialog } from './CancelOrderDialog';
import type { PosTable } from '@/features/tables/types';
import { useTables } from '@/features/tables/api';

import {
  useOpenSession,
  useCheckout,
  useSettleTab,
  useSaveTab,
  useFireKitchen,
} from './api';
import { useMenuItemsAvailable } from '@/features/menu/api';
import { api } from '@/lib/api';
import { useCartStore, selectTotal } from '@/features/pos/cart.store';
import type { CartLine, DiscountType, PaymentTender } from '@/features/pos/types';
import type { Customer } from './types';
import { useAuthStore } from '@/stores/auth.store';
import { usePosAuthStore } from '@/features/pos/pos-auth.store';
import { useScannerDebounce } from './scanner-debounce';
import PosLoginScreen from './PosLoginScreen';

import './pos-pro.css';

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;

/** Stable signature of an order's line-set — used to detect cart⇄server drift
 * so auto-save only fires on a real change (and never loops with the loader). */
function orderSig(
  lines: Array<{ productId?: string; menuItemId?: string; sku?: string; name?: string; description?: string; quantity: number | string; unitPrice: number | string; discountPercent?: number | string; taxId?: string | null; note?: string | null }>,
): string {
  return JSON.stringify(
    lines.map((l) => [
      l.menuItemId ?? l.productId ?? l.sku ?? '',
      l.name ?? l.description ?? '',
      Number(l.quantity),
      Number(l.unitPrice),
      Number(l.discountPercent ?? 0),
      l.taxId ?? '',
      l.note ?? '',
    ]),
  );
}

/** Map a server order line (Document line) into a cart line. */
function serverLineToCart(l: any): CartLine {
  const id =
    l.id ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() : Math.random().toString(36).slice(2));
  return {
    lineId: id,
    productId: l.productId ?? undefined,
    menuItemId: l.menuItemId ?? undefined,
    name: l.description,
    quantity: Number(l.quantity),
    unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent ?? 0),
    taxId: l.taxId ?? undefined,
    note: l.note ?? undefined,
    taxInclusive: l.taxInclusive ?? undefined,
  };
}

/** Map cart lines into printable receipt lines (modifier objects → names). */
function cartToReceiptLines(ls: CartLine[]): ReceiptLine[] {
  return ls.map((l) => ({
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountPercent: l.discountPercent,
    note: l.note,
    modifiers: l.modifiers?.map((m) => m.name).filter(Boolean),
  }));
}

/** Map a cart line into a checkout / save-tab line payload. */
function cartLineToPayload(l: CartLine) {
  return {
    productId: l.productId,
    menuItemId: l.menuItemId,
    sku: l.sku,
    description: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    taxId: l.taxId,
    discountPercent: l.discountPercent > 0 ? l.discountPercent : undefined,
    note: l.note,
    modifiers: l.modifiers && l.modifiers.length > 0 ? l.modifiers : undefined,
    comboId: l.comboId,
    taxInclusive: l.taxInclusive,
  };
}

const TerminalPage: React.FC = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const posUser = usePosAuthStore((s) => s.user);
  const [showPosLogin, setShowPosLogin] = useState(!usePosAuthStore.getState().user);

  /* ============== Catalog (menu-based) ============== */
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const { data: menuPayload } = useMenuItemsAvailable();
  const categories = useMemo(
    () => (menuPayload?.categories ?? []).map((c: any) => ({ id: c.id, name: c.name, color: c.color, icon: c.icon })),
    [menuPayload],
  );
  // The POS sells MenuItems (not raw products). Map them into the catalog-card
  // shape MenuGrid expects; `id` is the MenuItem id used for the sale line.
  const products = useMemo(() => {
    const term = search.trim().toLowerCase();
    const catName = new Map((menuPayload?.categories ?? []).map((c: any) => [c.id, c.name]));
    return (menuPayload?.items ?? [])
      .filter((it: any) => it.isAvailable)
      .filter((it: any) => !activeCategory || it.categoryId === activeCategory)
      .filter((it: any) => !term || it.name.toLowerCase().includes(term) || (it.code ?? '').toLowerCase().includes(term))
      .map((it: any) => ({
        id: it.id,
        name: it.name,
        sku: it.code,
        salesPrice: it.basePrice,
        categoryId: it.categoryId,
        category: it.categoryId ? { name: catName.get(it.categoryId) ?? '' } : null,
      }));
  }, [menuPayload, activeCategory, search]);

  /* ============== Shift ============== */
  const { data: session, refetch: refetchSession } = useOpenSession();
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);

  /* ============== Customer ============== */
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);

  /* ============== Discounts ============== */
  const [showDiscount, setShowDiscount] = useState(false);
  const [lineForDiscount, setLineForDiscount] = useState<CartLine | null>(null);

  /* ============== Void item ============== */
  const [voidLine, setVoidLine] = useState<CartLine | null>(null);

  /* ============== Split bill ============== */
  const [showSplitBill, setShowSplitBill] = useState(false);

  /* ============== Cancel order ============== */
  const [showCancelOrder, setShowCancelOrder] = useState(false);
  const [cancelInvoice, setCancelInvoice] = useState<{ id: string; number: string } | null>(null);

  /* ============== Payment ============== */
  const [showPayment, setShowPayment] = useState(false);

  /* ============== Manager override ============== */
  const [overrideKind, setOverrideKind] = useState<'discount' | 'void' | 'manual_refund' | null>(null);
  const [overrideResolver, setOverrideResolver] = useState<((id: string | null) => void) | null>(null);

  /* ============== Receipt preview (Sprint P3) ============== */
  const [showBillPreview, setShowBillPreview] = useState(false);
  const [showKotPreview, setShowKotPreview] = useState(false);
  const [lastCompleted, setLastCompleted] = useState<{
    lines: ReceiptLine[]; total: number; discountPercent: number; discountAmount: number;
    orderTypeLabel?: string; tableLabel?: string; customerName?: string;
    invoiceNumber?: string;
  } | null>(null);

  /* ============== POS Mode (Tables vs Counter) ============== */
  const [posMode, setPosMode] = useState<'tables' | 'counter'>('tables');
  /* selectedTableId � the table being worked on (null = grid view). */
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  /* tableView: 'grid' | 'detail' | 'ordering' � sub-state within tables mode. */
  const [tableView, setTableView] = useState<'grid' | 'detail' | 'ordering'>('grid');
  const tableCartsRef = useRef<Map<string, {
    lines: CartLine[];
    sentLineIds: string[];
    transactionDiscountPercent: number;
    transactionDiscountType: DiscountType;
    transactionDiscountAmount: number;
  }>>(new Map());
  const currentSentLineIds = useRef<Set<string>>(new Set());

  /* ============== P4: AddOns dialog ============== */
  const [addOnsFor, setAddOnsFor] = useState<string | null>(null);

  /* ============== Fullscreen ============== */
  const [fullscreen, setFullscreen] = useState(false);

  /* ============== Cart (zustand) ============== */
  const lines = useCartStore((s) => s.lines);
  const transactionDiscountPercent = useCartStore((s) => s.transactionDiscountPercent);
  const total = useCartStore(selectTotal);
  const tableId = useCartStore((s) => s.tableId);
  const addLine = useCartStore((s) => s.addLine);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const setDiscount = useCartStore((s) => s.setDiscount);
  const setNote = useCartStore((s) => s.setNote);
  const removeLine = useCartStore((s) => s.removeLine);
  const setTransactionDiscount = useCartStore((s) => s.setTransactionDiscount);
  const setCashSession = useCartStore((s) => s.setCashSession);
  const setOrderType = useCartStore((s) => s.setOrderType);
  const clearCart = useCartStore((s) => s.clear);

  /* ============== Tables (auto-polling, 8s) ============== */
  const { data: tables = [], isLoading: tablesLoading } = useTables({ active: true, status: undefined });

  /* Derived selected table � derived from selectedTableId + tables list */
  const selectedTable = selectedTableId
    ? tables.find((t) => t.id === selectedTableId) ?? null
    : null;

  /* ============== Per-table cart persistence ============== */
  const saveCurrentTableCart = useCallback(() => {
    const key = selectedTableId ?? 'counter';
    tableCartsRef.current.set(key, {
      lines: useCartStore.getState().lines,
      sentLineIds: Array.from(currentSentLineIds.current),
      transactionDiscountPercent: useCartStore.getState().transactionDiscountPercent,
      transactionDiscountType: useCartStore.getState().transactionDiscountType,
      transactionDiscountAmount: useCartStore.getState().transactionDiscountAmount,
    });
  }, [selectedTableId]);

  const loadTableCart = useCallback((tableId: string) => {
    const saved = tableCartsRef.current.get(tableId);
    const t = tables.find((t) => t.id === tableId) ?? null;
    useCartStore.setState({
      lines: saved?.lines ?? [],
      transactionDiscountPercent: saved?.transactionDiscountPercent ?? 0,
      transactionDiscountType: saved?.transactionDiscountType ?? 'percentage',
      transactionDiscountAmount: saved?.transactionDiscountAmount ?? 0,
      orderType: 'dine-in',
      tableId: tableId ?? undefined,
      tableNumber: t ? t.number : undefined,
      tableName: t ? t.name : undefined,
      sentToKitchen: false,
    });
    currentSentLineIds.current = new Set(saved?.sentLineIds ?? []);
  }, [tables]);

  const tableHasLocalCart = useCallback((tableId: string) => {
    const cart = tableCartsRef.current.get(tableId);
    return !!(cart && cart.lines.length > 0);
  }, []);

  const localCartTotal = useCallback((tableId: string) => {
    const cart = tableCartsRef.current.get(tableId);
    if (!cart) return 0;
    return cart.lines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0);
  }, []);

  /* M4 open-tab dine-in — server order is the source of truth per table. */
  const settleTabMut = useSettleTab();
  const saveTab = useSaveTab();
  const fireKitchen = useFireKitchen();
  /* True while we're fetching+loading a table's order — gates auto-save so the
   * cleared/loading cart isn't pushed back to the server. */
  const [pendingTableLoad, setPendingTableLoad] = useState<string | null>(null);
  /* Signature of the line-set last synced to/from the server (guards the
   * load⇄auto-save loop: we only save when the cart differs from this). */
  const tabSyncSig = useRef<string>('');

  /* Imperatively fetch THIS table's open order fresh from the server and load it
   * into the cart. Deterministic — no react-query cache races on switch/return. */
  const loadTableOrder = useCallback(async (id: string) => {
    try {
      const doc = (await api.get(`/pos/tabs/${id}`)).data as any;
      const serverLines = (((doc?.lines) ?? []) as any[]).map(serverLineToCart);
      // Only apply if the cashier is still on this table (didn't switch again).
      if (useCartStore.getState().tableId === id) {
        useCartStore.getState().load(serverLines);
        tabSyncSig.current = orderSig(serverLines);
      }
    } catch {
      if (useCartStore.getState().tableId === id) {
        useCartStore.getState().load([]);
        tabSyncSig.current = orderSig([]);
      }
    } finally {
      setPendingTableLoad((cur) => (cur === id ? null : cur));
    }
  }, []);

  const handleTableClick = useCallback((t: PosTable) => {
    // One open order per table. Flush the table we're leaving, clear the cart,
    // set the new table, then imperatively fetch + load THIS table's order.
    const cart = useCartStore.getState();
    // Flush any unsaved edit on the table we're leaving (fire-and-forget —
    // state changes MUST happen BEFORE any network wait to keep UI responsive).
    if (cart.tableId && cart.tableId !== t.id && orderSig(cart.lines) !== tabSyncSig.current) {
      saveTab.mutate({ tableId: cart.tableId, lines: cart.lines.map(cartLineToPayload), partnerId: customer?.id });
    }
    setPendingTableLoad(t.id);          // gate auto-save until the load finishes
    cart.clear();
    cart.setTable(t.id, t.number, t.name);
    tabSyncSig.current = '__loading__';
    setSelectedTableId(t.id);
    setTableView('ordering');
    setPosMode('tables');
    void loadTableOrder(t.id);
  }, [saveTab, customer?.id, loadTableOrder]);

  const handleNewOrder = useCallback((t: PosTable) => {
    tableCartsRef.current.delete(t.id);
    loadTableCart(t.id);
    currentSentLineIds.current = new Set();
    setSelectedTableId(t.id);
    setTableView('ordering');
    setPosMode('tables');
  }, [loadTableCart]);

  const handleContinueDraft = useCallback((t: PosTable) => {
    loadTableCart(t.id);
    setSelectedTableId(t.id);
    setTableView('ordering');
    setPosMode('tables');
  }, [loadTableCart]);

  const handleGoBackToGrid = useCallback(() => {
    const cart = useCartStore.getState();
    if (cart.tableId && orderSig(cart.lines) !== tabSyncSig.current) {
      saveTab.mutate({ tableId: cart.tableId, lines: cart.lines.map(cartLineToPayload), partnerId: customer?.id });
    }
    saveCurrentTableCart();
    setSelectedTableId(null);
    setTableView('grid');
  }, [saveCurrentTableCart, saveTab, customer?.id]);

  /* Auto-save cart to tableCartsRef when leaving the OrderPanel view. */
  useEffect(() => {
    if (tableView === 'ordering') {
      return () => { saveCurrentTableCart(); };
    }
  }, [tableView, saveCurrentTableCart]);

  /* ============== Mutations ============== */
  const checkout = useCheckout();

  /* On mount, baseline the sync signature to whatever the cart rehydrated to
   * (sessionStorage persists the cart across reloads). Without this, a stale
   * persisted cart looks like an unsaved change and the auto-save below would
   * clobber the bound table's real order with stale items on first render. */
  useEffect(() => {
    tabSyncSig.current = orderSig(useCartStore.getState().lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Auto-save: persist the cart back to the table's order whenever it changes
   * (debounced). No table selected = counter mode, no auto-save. */
  useEffect(() => {
    if (!tableId || pendingTableLoad) return;
    const currentSig = orderSig(lines);
    if (currentSig === tabSyncSig.current) return;
    const h = setTimeout(() => {
      saveTab.mutate(
        { tableId, lines: lines.map(cartLineToPayload), partnerId: customer?.id },
        { onSuccess: () => { tabSyncSig.current = currentSig; } },
      );
    }, 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, tableId, pendingTableLoad, customer?.id]);
  const [isTabSettle, setIsTabSettle] = useState(false);

  /* Keep cart's cashSessionId in sync with the active shift. */
  useEffect(() => {
    setCashSession(session?.id ?? undefined);
  }, [session?.id, setCashSession]);

  /* Clear POS PIN session when leaving the terminal — forces re-PIN on next visit. */
  useEffect(() => {
    return () => {
      usePosAuthStore.getState().logout();
    };
  }, []);

  const locked = !session || !posUser;
  const orderTypeLabel = posMode === 'counter' ? 'Takeaway' : 'Dine In';
  const activeTableLabel = selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : null;
  const [showTableSelector, setShowTableSelector] = useState(false);

  /* ============== Catalog actions ============== */
  const onPickProduct = useCallback((p: any) => {
    if (locked) return;
    // If the product has a SKU = 'combo:xxx', treat it as a combo line.
    if (p.sku && p.sku.startsWith('combo:')) {
      const comboId = p.sku.slice('combo:'.length);
      addLine({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        quantity: 1,
        unitPrice: Number(p.salesPrice || 0),
        comboId,
      });
      return;
    }
    // Open the AddOns dialog if the product has any modifier groups; the
    // dialog itself handles "no groups" by adding the line directly.
    setAddOnsFor(p.id);
  }, [addLine, locked]);

  const onAddOnsConfirm = useCallback((input: { productId: string; productName: string; unitPrice: number; sku: string | null; modifiers: Array<{ modifierId: string; name: string; priceDelta: number }>; quantity: number; note: string; taxInclusive?: boolean }) => {
    // input.productId is the MenuItem id (AddOnsDialog uses useMenuItemBundle).
    // The sale line is a MenuItem, NOT a product — only menuItemId is set.
    addLine({
      menuItemId: input.productId,
      sku: input.sku ?? undefined,
      name: input.productName,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      note: input.note || undefined,
      taxInclusive: input.taxInclusive,
      modifiers: input.modifiers.length > 0 ? input.modifiers : undefined,
    });
    setAddOnsFor(null);
  }, [addLine]);

  /* P6: mirror the cart to localStorage so /pos/display (the customer-facing
     pole display) can poll and re-render in real time. */
  useEffect(() => {
    const snap = {
      lines,
      transactionDiscountPercent,
      total,
      tendered: 0,
      change: 0,
      status: lines.length === 0 ? 'idle' : 'building',
    };
    try { localStorage.setItem('pos-display-cart', JSON.stringify(snap)); } catch { /* noop */ }
  }, [lines, transactionDiscountPercent, total]);

  /* Legacy auto-add on exact SKU match (kept for backwards compat; the
     debouncer below also fires so the two paths are belt-and-suspenders). */
  useEffect(() => {
    const q = search.trim();
    if (!q || locked) return;
    const match = (products as any[]).find(
      (p) => p.sku && p.sku.toLowerCase() === q.toLowerCase(),
    );
    if (match) {
      onPickProduct(match);
      setSearch('');
    }
  }, [search, products, onPickProduct, locked]);

  /* P6: HID scanner debouncing — the topbar search calls onScan only when
     the input looks like a scan (rapid keystrokes). Slow typing still works. */
  const onScan = useCallback((code: string) => {
    // Menu-based POS: resolve a scanned code against the loaded MenuItems (by
    // their code/sku), not the raw products catalogue.
    const match = (products as any[]).find(
      (p) => p.sku && p.sku.toLowerCase() === code.toLowerCase(),
    );
    if (match) { onPickProduct(match); setSearch(''); }
  }, [products, onPickProduct]);
  useScannerDebounce(search, onScan);

  const onInc = (line: CartLine) => setQuantity(line.lineId, line.quantity + 1);
  const onDec = (line: CartLine) => setQuantity(line.lineId, line.quantity - 1);
  const onRemove = (line: CartLine) => removeLine(line.lineId);
  const onLineDiscount = (line: CartLine) => setLineForDiscount(line);
  const onLineDiscountApply = (lineId: string, amount: number, type?: DiscountType) => {
    setDiscount(lineId, amount, type);
    if (amount > 0) {
      toast.success(type === 'fixed' ? `Line discount UGX ${amount.toLocaleString()} applied` : `Line discount ${amount}% applied`);
    } else {
      toast.success('Line discount cleared');
    }
  };
  const onLineNote = (line: CartLine) => {
    const next = window.prompt(`Note for "${line.name}"`, line.note ?? '');
    if (next !== null) setNote(line.lineId, next);
  };

  /* ============== Manager override helper ============== */
  const requestOverride = useCallback((kind: 'discount' | 'void' | 'manual_refund'): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setOverrideKind(kind);
      setOverrideResolver(() => resolve);
    });
  }, []);

  const onOverrideVerified = (managerId: string | null) => {
    if (overrideResolver) overrideResolver(managerId);
    setOverrideKind(null);
    setOverrideResolver(null);
  };

  /* ============== Order-level discount ============== */
  const onApplyOrderDiscount = (percent: number) => {
    onApplyOrderDiscountEx(percent, 'percentage');
  };
  const onApplyOrderDiscountEx = (amount: number, type: DiscountType) => {
    const needsOverride = type === 'percentage' ? amount >= 10 : amount >= 50000;
    if (needsOverride) {
      requestOverride('discount').then((mgrId) => {
        if (!mgrId) {
          toast.error('Manager override cancelled');
          return;
        }
        setTransactionDiscount(amount, type);
        useCartStore.setState({ overrideById: mgrId });
        toast.success(type === 'fixed' ? `UGX ${amount.toLocaleString()} discount applied with override` : `${amount}% discount applied with override`);
      });
    } else {
      setTransactionDiscount(amount, type);
      toast.success(type === 'fixed' ? `UGX ${amount.toLocaleString()} discount applied` : `${amount}% discount applied`);
    }
  };

  /* ============== Charge (payment) ============== */
  const onCharge = () => {
    if (lines.length === 0) {
      toast.error('Cart is empty');
      return;
    }
    setShowPayment(true);
  };

  /* Fire the table's saved order to the kitchen (auto-save flushes first). */
  const handleSendToKitchen = async () => {
    if (!tableId) { toast.error('No table selected'); return; }
    if (lines.length === 0) { toast.error('Order is empty'); return; }
    try {
      await saveTab.mutateAsync({ tableId, lines: lines.map(cartLineToPayload), partnerId: customer?.id });
      tabSyncSig.current = orderSig(lines);
      const res = await fireKitchen.mutateAsync({ tableId });
      useCartStore.getState().markSentToKitchen(true);
      toast.success(`Sent ${(res as any)?.count ?? ''} ticket(s) to the kitchen`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to send to kitchen');
    }
  };

  /* Settle (pay) the table's order. Flush any pending edit, then open payment. */
  const handleSettleTab = async () => {
    if (!tableId || lines.length === 0) { toast.error('Nothing to settle'); return; }
    try {
      await saveTab.mutateAsync({ tableId, lines: lines.map(cartLineToPayload), partnerId: customer?.id });
      tabSyncSig.current = orderSig(lines);
    } catch {
      toast.error('Could not save the order before settling');
      return;
    }
    setIsTabSettle(true);
    setShowPayment(true);
  };

  const onSettle = async (input: { tenders: PaymentTender[]; transactionDiscountPercent: number; overrideById?: string }) => {
    /* M4: settle the accumulated server tab instead of cart-checkout */
    if (isTabSettle && tableId) {
      try {
        const res = await settleTabMut.mutateAsync({
          tableId,
          tenders: input.tenders,
          cashSessionId: session?.id,
        });
        toast.success(`Order settled — change ${fmt((res as any).change ?? 0)}`);
        setIsTabSettle(false);
        tabSyncSig.current = '';
        clearCart();
        setCustomer(null);
        setShowPayment(false);
        setSelectedTableId(null);
        setTableView('grid');
        refetchSession();
        currentSentLineIds.current.clear();
      } catch (e: any) {
        toast.error(e?.response?.data?.message || 'Settle failed');
      }
      return;
    }

    const checkoutLines = lines.map((l) => ({
      productId: l.productId,
      menuItemId: l.menuItemId,
      sku: l.sku,
      description: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxId: l.taxId,
      discountPercent: l.discountPercent > 0 ? l.discountPercent : undefined,
      note: l.note,
      // H1: carry add-ons / combo / tax-inclusive through to the server so the
      // receipt + GL stay authoritative (the API now whitelists these fields).
      modifiers: l.modifiers && l.modifiers.length > 0 ? l.modifiers : undefined,
      comboId: l.comboId,
      taxInclusive: l.taxInclusive,
    }));
    const payload = {
      lines: checkoutLines,
      tenders: input.tenders,
      transactionDiscountPercent: input.transactionDiscountPercent || transactionDiscountPercent,
      overrideById: input.overrideById,
      cashSessionId: session?.id,
      branchId: undefined,
      reference: undefined,
      partnerId: customer?.id,
      // Tables (ADR-012): tie the sale to the active table when present.
      tableId: tableId || undefined,
      guestCount: undefined as number | undefined,
    } as any;
    try {
      const res = await checkout.mutateAsync(payload);
      toast.success(`Sale ${res.invoiceNumber} settled — change ${fmt(res.change)}`);
      // P9: surface any low-stock warnings from the backend.
      if (res.lowStock && res.lowStock.length > 0) {
        for (const ls of res.lowStock) {
          toast.warning(
            `Low stock: ${ls.productName} — on hand ${ls.onHand}, sold ${ls.requested}`,
            { duration: 8000 },
          );
        }
      }
      setLastCompleted({
        lines: cartToReceiptLines(lines),
        total, invoiceNumber: res.invoiceNumber,
        discountPercent: transactionDiscountPercent || 0,
        discountAmount: transactionDiscountPercent > 0 ? total - lines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0) : 0,
        orderTypeLabel: orderTypeLabel ?? undefined,
        tableLabel: activeTableLabel ?? undefined,
        customerName: customer?.name,
      });
      clearCart();
      setCustomer(null);
      setShowPayment(false);
      refetchSession();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Checkout failed';
      // P11 offline fallback: if the network is down (no response at all,
      // or a 5xx/timeout), queue the sale locally. The next time the cashier
      // reconnects, the queue replays with the SAME Idempotency-Key so the
      // backend returns the original response — no double-charge.
      const status = e?.response?.status;
      const isOffline = !status || status === 0 || status >= 500 || status === 408 || status === 429;
      const networkDown = typeof navigator !== 'undefined' && !navigator.onLine;
      if (isOffline || networkDown) {
        try {
          const queued = await enqueueSale(payload);
          toast.warning(
            `Network down — sale queued (${queued.idempotencyKey.slice(0, 8)}). It will sync automatically when you're back online.`,
            { duration: 12000 },
          );
          // Still clear the cart and show a "draft" receipt placeholder so
          // the cashier can hand the customer a hand-written slip if needed.
          setLastCompleted({
            lines: cartToReceiptLines(lines),
            total, invoiceNumber: `PENDING-${queued.idempotencyKey.slice(0, 8).toUpperCase()}`,
            discountPercent: transactionDiscountPercent || 0,
            discountAmount: transactionDiscountPercent > 0 ? total - lines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0) : 0,
            orderTypeLabel: orderTypeLabel ?? undefined,
            tableLabel: activeTableLabel ?? undefined,
            customerName: customer?.name,
          });
          clearCart();
          setCustomer(null);
          setShowPayment(false);
          return;
        } catch (qErr: any) {
          // If even IndexedDB is unavailable, surface the original error.
          toast.error(`Queue failed: ${qErr?.message || 'unknown'}. Original error: ${msg}`);
          throw e;
        }
      }
      // If the backend says manager override is required, prompt and retry.
      if (/manager override/i.test(msg) && !input.overrideById) {
        const mgrId: string | null = await requestOverride('discount');
        if (mgrId) {
          await onSettle({ ...input, overrideById: mgrId });
          return;
        }
      }
      toast.error(msg);
      throw e;
    }
  };

  /* ============== Hold ============== */
  /* ============== Bill / KOT preview ============== */
  const onPrintBill = () => {
    if (lines.length === 0) { toast.error('Cart is empty'); return; }
    setShowBillPreview(true);
  };

  /* ============== Split (placeholder — full split comes with P3 splits) ============== */
  const onSplit = () => {
    toast.info('Split-bill UI uses the multi-tender PaymentDialog. Add multiple tenders with different methods.');
    setShowPayment(true);
  };

  /* ============== Tax / SC (placeholder) ============== */
  const onAddTax = () => {
    toast.info('Tax is set per-product via the Tax catalog. All seeded products carry 18% VAT.');
  };

  /* ============== Fullscreen toggle ============== */
  const onToggleFullscreen = () => {
    setFullscreen((f: boolean) => {
      const next = !f;
      try {
        if (next) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
      } catch { /* noop */ }
      return next;
    });
  };

  /* ============== Keyboard shortcuts ============== */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'F2') { e.preventDefault(); onCharge(); }
      else if (e.key === 'F4') { e.preventDefault(); onSplit(); }
      else if (e.key === 'F8') { e.preventDefault(); onPrintBill(); }
      else if (e.key === 'Escape') {
        setShowPayment(false); setShowCustomer(false);
        setShowDiscount(false); setShowOpenShift(false); setShowCloseShift(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCharge, onSplit, onPrintBill]);

  const logout = () => {
    useAuthStore.getState().clear();
    navigate('/login', { replace: true });
  };

  const handleUserChanged = () => {
    // Force re-render — locked state recalculates via posUser
    setShowPosLogin(!usePosAuthStore.getState().user);
  };

  return (
    <div className={'pos-shell-pro' + (fullscreen ? ' dark-mode' : '')}>
      {/* POS PIN Login screen — shown until a cashier authenticates */}
      {showPosLogin && !posUser ? (
        <PosLoginScreen onLoggedIn={() => setShowPosLogin(false)} />
      ) : null}

      <Topbar
        search={search}
        onSearch={setSearch}
        onOpenReports={() => navigate('/pos/reports')}
        onOpenShift={() => setShowOpenShift(true)}
        onCloseShift={() => setShowCloseShift(true)}
        onOpenTableSelector={() => setShowTableSelector(true)}
        activeTableLabel={selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : null}
        staffName={user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : undefined}
        staffRole={(user as any)?.roles?.[0]}
        session={session ?? null}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onLogout={logout}
        onUserChanged={handleUserChanged}
        rightExtras={<OfflineIndicator />}
        posMode={posMode}
        onChangeMode={setPosMode}
      />

      {/* Workflow stepper */}
      {/* {hasActiveOrder && !locked ? (
        <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-white border-b border-slate-100 text-[11px] font-semibold text-slate-500">
          <span className={sentToKitchen ? 'text-emerald-600' : 'text-amber-600'}>
            {sentToKitchen ? <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" /> : <Circle className="w-3.5 h-3.5 inline mr-1" />}
            {orderTypeLabel ?? 'Order'}
          </span>
          <span className="text-slate-300 mx-1">›</span>
          <span className="text-slate-400">
            {activeTableLabel || (orderType === 'dine-in' ? 'Select table' : '—')}
          </span>
          <span className="text-slate-300 mx-1">›</span>
          <span className={lines.length > 0 ? 'text-slate-800' : 'text-slate-400'}>
            {lines.length > 0 ? `${lines.length} item${lines.length !== 1 ? 's' : ''}` : 'Add items'}
          </span>
          <span className="text-slate-300 mx-1">›</span>
          <span className={sentToKitchen ? 'text-emerald-600' : 'text-slate-400'}>
            {sentToKitchen ? 'Sent to kitchen' : 'Kitchen'}
          </span>
          <span className="text-slate-300 mx-1">›</span>
          <span className="text-slate-400">Payment</span>
          <span className="text-slate-300 mx-1">›</span>
          <span className="text-slate-400">Receipt</span>
        </div>
      ) : null} */}

      <div className="pos-body-pro" style={
        tableView === 'grid' || tableView === 'detail'
          ? { gridTemplateColumns: '1fr' }
          : undefined
      }>
        {locked ? (
          <div className="pos-lock-overlay-pro">
            <div className="pos-lock-icon"><LockIcon className="h-10 w-10" /></div>
            <div className="pos-lock-title">Open your shift to start selling</div>
            <div className="pos-lock-sub">Pick a cash register, count your opening float, then tap "Open shift".</div>
            <button
              type="button"
              onClick={() => setShowOpenShift(true)}
              className="pos-action-btn-pro bg-emerald h-12 px-6"
              style={{ width: 'auto', paddingLeft: 24, paddingRight: 24, minHeight: 48 }}
            >
              <Coffee className="pos-action-icon" /> Open shift
            </button>
          </div>
        ) : tableView === 'grid' ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-6 py-3 border-b bg-white">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">Tables</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPosMode('counter')}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200"
                >
                  Switch to Counter
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {tablesLoading ? (
                <div className="text-center text-slate-400 py-12">Loading tables...</div>
              ) : tables.length === 0 ? (
                <div className="text-center text-slate-400 py-12">
                  <LayoutGrid className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="font-semibold">No tables configured</p>
                  <p className="text-xs mt-1">Create tables in the Tables admin page first.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {tables.map((t) => {
                    const openOrders = (t.orders ?? []).filter((o) => !o.closedAt);
                    const backendTotal = openOrders.reduce((s, o) => s + Number(o.document?.totalAmount ?? 0), 0);
                    const statusColors: Record<string, string> = {
                      available: 'bg-emerald-400',
                      occupied: 'bg-amber-400',
                      reserved: 'bg-sky-400',
                      out_of_service: 'bg-slate-400',
                    };
                    // Trust server status (auto-synced via open orders)
                    const status = t.status;
                    const dotClass = statusColors[status] ?? 'bg-slate-300';
                    const statusLabel = status === 'occupied' ? 'Occupied' : status === 'out_of_service' ? 'Out of service' : status === 'reserved' ? 'Reserved' : 'Available';
                    const hasLocal = tableHasLocalCart(t.id);
                    const local = localCartTotal(t.id);
                    const combinedTotal = backendTotal + local;
                    const combinedCount = openOrders.length + (hasLocal ? 1 : 0);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => handleTableClick(t)}
                        className="relative rounded-xl p-4 border-2 border-slate-200 bg-white hover:border-indigo-400 hover:shadow-lg transition-all text-left group min-h-[120px]"
                      >
                        <span className={`absolute top-3 right-3 w-3 h-3 rounded-full ${dotClass} shadow-sm`} />
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                          T{t.number}
                        </div>
                        <div className="text-sm font-bold text-slate-800 leading-tight pr-6 mb-2">
                          {t.name}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-slate-500 mb-1">
                          <Users className="w-3 h-3" /> {t.seats}
                          <span className={'ml-auto text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ' + (status === 'occupied' ? 'bg-amber-100 text-amber-700' : status === 'out_of_service' ? 'bg-slate-100 text-slate-500' : status === 'reserved' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700')}>
                            {statusLabel}
                          </span>
                        </div>
                        {combinedCount > 0 ? (
                          <>
                            <div className="text-[10px] font-semibold text-slate-600 mb-0.5">
                              {combinedCount} order{combinedCount !== 1 ? 's' : ''} · UGX {combinedTotal.toLocaleString()}
                            </div>
                            {hasLocal && (
                              <div className="text-[9px] text-amber-600 font-semibold">
                                ⚡ Draft cart ({tableCartsRef.current.get(t.id)?.lines.length ?? 0} items)
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-[10px] text-slate-400 font-semibold mt-1">Tap to open</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : tableView === 'detail' && selectedTable ? (
          <TableDetailView
            table={selectedTable}
            onBack={handleGoBackToGrid}
            onStartOrder={handleNewOrder}
            onContinueDraft={handleContinueDraft}
            hasLocalCart={tableHasLocalCart(selectedTable.id)}
          />
        ) : (
          <>
            <div className="pos-menus-pro">
              <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border-b border-indigo-100 flex-shrink-0">
                <button
                  type="button"
                  onClick={handleGoBackToGrid}
                  className="flex items-center gap-1 text-xs font-bold text-indigo-700 hover:text-indigo-900"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Tables
                </button>
                {selectedTable && (
                  <span className="text-xs font-bold text-indigo-800">
                    T{selectedTable.number}{selectedTable.name ? ` ${selectedTable.name}` : ''}
                  </span>
                )}
              </div>
              <CategoryStrip
                categories={categories as any}
                activeId={activeCategory}
                onSelect={setActiveCategory}
              />
              <div className="relative flex-1 min-h-0">
                <MenuGrid products={products as any} locked={locked} onPick={onPickProduct} />
              </div>
            </div>

            <OrderPanel
              customerName={customer?.name}
              orderTypeLabel={orderTypeLabel ?? undefined}
              tableLabel={selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : undefined}
              tableId={tableId}
              onInc={onInc}
              onDec={onDec}
              onRemove={onRemove}
              onNote={onLineNote}
              onLineDiscount={onLineDiscount}
              onPrintBill={onPrintBill}
              onCharge={onCharge}
              onSplit={onSplit}
              onAddCustomer={() => setShowCustomer(true)}
              onAddDiscount={() => setShowDiscount(true)}
              onAddTax={onAddTax}
              onCloseOrder={() => {
                saveCurrentTableCart();
                setSelectedTableId(null);
                setTableView('grid');
                clearCart();
                setCustomer(null);
                setOrderType(undefined);
                useCartStore.setState({ tableId: undefined, tableNumber: undefined, tableName: undefined, sentToKitchen: false });
              }}
              onPrintKot={() => { if (lines.length === 0) { toast.error('Cart is empty'); return; } setShowKotPreview(true); }}
              onVoidItem={(line) => setVoidLine(line)}
              onSplitBill={() => setShowSplitBill(true)}
              onSendToKitchen={tableId ? handleSendToKitchen : undefined}
              onSettleTab={tableId ? handleSettleTab : undefined}
            />
          </>
        )}
      </div>

      {/* Dialogs */}
      <ShiftOpenDialog
        open={showOpenShift}
        onClose={() => setShowOpenShift(false)}
        onOpened={() => refetchSession()}
      />
      <ShiftCloseDialog
        open={showCloseShift}
        session={session ?? null}
        onClose={() => setShowCloseShift(false)}
        onClosed={() => {
          refetchSession();
          setTimeout(() => navigate('/pos/reports'), 600);
        }}
      />
      <CustomerDialog
        open={showCustomer}
        onClose={() => setShowCustomer(false)}
        onPick={(c) => { setCustomer(c); toast.success(`Customer: ${c.name}`); }}
      />
      <DiscountDialog
        open={showDiscount}
        initialPercent={transactionDiscountPercent}
        onClose={() => setShowDiscount(false)}
        onApply={onApplyOrderDiscount}
        onApplyEx={onApplyOrderDiscountEx}
      />
      {lineForDiscount ? (
        <LineDiscountDialog
          open={!!lineForDiscount}
          line={lineForDiscount}
          onClose={() => setLineForDiscount(null)}
          onApply={onLineDiscountApply}
        />
      ) : null}
      <PaymentDialog
        open={showPayment}
        total={total}
        effectiveDiscountPercent={Math.max(transactionDiscountPercent, ...lines.map((l) => l.discountPercent))}
        onRequestOverride={requestOverride}
        onClose={() => { setShowPayment(false); setIsTabSettle(false); }}
        onSettle={onSettle}
      />
      <OverrideDialog
        open={!!overrideKind}
        kind={overrideKind ?? 'discount'}
        onClose={() => onOverrideVerified(null)}
        onVerified={onOverrideVerified}
      />

      {/* Void item dialog */}
      <VoidItemDialog
        open={!!voidLine}
        line={voidLine}
        onClose={() => setVoidLine(null)}
        onConfirm={(lineId) => {
          removeLine(lineId);
          toast.success('Item voided');
        }}
      />

      {/* Split bill dialog */}
      {tableId ? (
        <SplitBillDialog
          open={showSplitBill}
          onClose={() => setShowSplitBill(false)}
          tableId={tableId}
        />
      ) : null}

      {/* Cancel order dialog */}
      <CancelOrderDialog
        open={showCancelOrder}
        invoiceId={cancelInvoice?.id ?? null}
        invoiceNumber={cancelInvoice?.number ?? null}
        onClose={() => { setShowCancelOrder(false); setCancelInvoice(null); }}
        onDone={() => { clearCart(); setCustomer(null); }}
      />

      <ReceiptPreview
        open={showBillPreview}
        onClose={() => setShowBillPreview(false)}
        type="bill"
        title="Bill Receipt"
        lines={cartToReceiptLines(lines)}
        total={total}
        discountPercent={transactionDiscountPercent || undefined}
        discountAmount={total - lines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0)}
        orderTypeLabel={orderTypeLabel ?? undefined}
        tableLabel={activeTableLabel ?? undefined}
        customerName={customer?.name}
      />

      <ReceiptPreview
        open={showKotPreview}
        onClose={() => setShowKotPreview(false)}
        type="kot"
        title="Kitchen Order Ticket"
        lines={cartToReceiptLines(lines)}
        total={total}
        orderTypeLabel={orderTypeLabel ?? undefined}
        tableLabel={activeTableLabel ?? undefined}
        customerName={customer?.name}
      />

      {lastCompleted && (
        <ReceiptPreview
          open
          onClose={() => setLastCompleted(null)}
          type="bill"
          title={`Receipt ${lastCompleted.invoiceNumber ?? ''}`}
          lines={lastCompleted.lines}
          total={lastCompleted.total}
          discountPercent={lastCompleted.discountPercent}
          discountAmount={lastCompleted.discountAmount}
          orderTypeLabel={lastCompleted.orderTypeLabel}
          tableLabel={lastCompleted.tableLabel}
          customerName={lastCompleted.customerName}
        />
      )}

      <AddOnsDialog
        open={!!addOnsFor}
        productId={addOnsFor}
        onClose={() => setAddOnsFor(null)}
        onAdd={onAddOnsConfirm}
      />

      {/* Tables (ADR-012) */}
      <TableSelectorDialog
        open={showTableSelector}
        onClose={() => setShowTableSelector(false)}
        selectedId={tableId ?? null}
        onPick={(t) => {
          // Route through the single switch handler so the previous table's cart
          // is flushed + cleared and THIS table's open order is loaded. Calling
          // setTable() alone would relabel tableId while keeping the old items
          // (they'd then auto-save onto the newly-picked table).
          setShowTableSelector(false);
          handleTableClick(t as unknown as PosTable);
        }}
      />

    </div>
  );
};

/* ============================================================
 * TableDetailView — shows a selected table's existing backend
 * orders and lets the cashier open a new order for it.
 * ============================================================ */
interface TableDetailViewProps {
  table: PosTable;
  onBack: () => void;
  onStartOrder: (t: PosTable) => void;
  onContinueDraft: (t: PosTable) => void;
  hasLocalCart: boolean;
}

const TableDetailView: React.FC<TableDetailViewProps> = ({ table, onBack, onStartOrder, onContinueDraft, hasLocalCart }) => {
  const statusBadge: Record<string, { label: string; cls: string }> = {
    available: { label: 'Available', cls: 'bg-emerald-100 text-emerald-700' },
    occupied: { label: 'Occupied', cls: 'bg-amber-100 text-amber-700' },
    reserved: { label: 'Reserved', cls: 'bg-sky-100 text-sky-700' },
    out_of_service: { label: 'Out of Service', cls: 'bg-slate-100 text-slate-600' },
  };
  const badge = statusBadge[table.status] ?? { label: table.status, cls: 'bg-slate-100 text-slate-600' };
  const openOrders = (table.orders ?? []).filter((o) => !o.closedAt);
  const tableTotal = openOrders.reduce((s, o) => s + Number(o.document?.totalAmount ?? 0), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b bg-white">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-bold text-indigo-700 hover:text-indigo-900 px-2 py-1 rounded hover:bg-indigo-50"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Tables
        </button>
        <div className="w-px h-5 bg-slate-200" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-800">
              Table {table.number}{table.name ? ` — ${table.name}` : ''}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}`}>
              {badge.label}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {table.seats} seats · Zone: {table.zone} · {openOrders.length} open order{openOrders.length !== 1 ? 's' : ''}
            {tableTotal > 0 && <span className="ml-2 font-semibold text-slate-700">· Total UGX {tableTotal.toLocaleString()}</span>}
            {hasLocalCart && <span className="ml-2 font-semibold text-amber-600">· ⚡ Draft in progress</span>}
          </div>
        </div>
          {hasLocalCart ? (
            <button
              type="button"
              onClick={() => onContinueDraft(table)}
              className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 shadow-sm"
            >
              <span className="text-sm leading-none">⚡</span> Continue Draft
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onStartOrder(table)}
              className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 shadow-sm"
            >
              <span className="text-sm leading-none">＋</span> New Order
            </button>
          )}
      </div>

      {/* Orders scrollable area */}
      <div className="flex-1 overflow-y-auto p-5">
        {openOrders.length === 0 && !hasLocalCart ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <LayoutGrid className="h-12 w-12 mb-3 opacity-40" />
            <p className="font-semibold text-sm">No open orders</p>
            <p className="text-xs mt-1">Tap "New Order" to start ringing up this table.</p>
          </div>
        ) : openOrders.length === 0 && hasLocalCart ? (
          <div className="flex flex-col items-center justify-center h-full text-amber-600">
            <p className="font-semibold text-sm">⚡ Draft in progress</p>
            <p className="text-xs mt-1">Items have been added but not yet sent to kitchen.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Open Orders</h3>
            {openOrders.map((o) => (
              <div
                key={o.id}
                className="flex items-center gap-4 bg-white border border-slate-200 rounded-xl px-5 py-4 hover:border-indigo-300 hover:shadow-sm transition-all"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                      {o.document?.documentNumber ?? `#${o.id.slice(0, 6)}`}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-400">
                      {o.openedAt ? `${Math.max(1, Math.floor((Date.now() - new Date(o.openedAt).getTime()) / 60000))}m ago` : 'New'}
                    </span>
                  </div>
                  {o.customerName && (
                    <div className="text-xs text-slate-600 font-medium truncate">{o.customerName}</div>
                  )}
                  {o.notes && (
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">Note: {o.notes}</div>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold text-slate-800">
                    {o.document ? `UGX ${Number(o.document.totalAmount || 0).toLocaleString()}` : '—'}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {o.document?.status ?? 'open'} · {o.guestCount ?? '?'} guests
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TerminalPage;