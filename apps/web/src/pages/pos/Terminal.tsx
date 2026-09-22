import { PendingSaleRecovery } from './PendingSaleRecovery';
import { OfflineIndicator } from './OfflineIndicator';
import { PosLogoffButton } from './PosLogoffButton';
import { useSaleQuote } from '@/features/pos/use-sale-quote';
import { cartLinePayload, cartSignature, draftPricing, draftRestore, serverLineToCart } from '@/features/pos/cart-payload';
import { useAuthStore } from '@/stores/auth.store';
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
 *   6. Press Shift Close (top bar, right, before Log off) → variance report
 *      + Z-report. Reports live at /pos/reports, outside the top bar.
 *
 * Permissions-aware: if the cashier doesn't have pos:discount, the discount
 * buttons are hidden.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Coffee, LayoutGrid, ArrowLeft, Printer, Clock, User } from 'lucide-react';
import { Lock as LockIcon } from 'lucide-react';

import { Topbar } from './Topbar';
import { AddOnsDialog } from './AddOnsDialog';
import { VariantPicker } from './VariantPicker';
import { AccompanimentPicker } from './AccompanimentPicker';
import { CategoryStrip } from './CategoryStrip';
import { MenuGrid } from './MenuGrid';
import { OrderPanel } from './OrderPanel';
import { PaymentDialog } from './PaymentDialog';
import { DiscountDialog } from './DiscountDialog';
import { LineDiscountDialog } from './LineDiscountDialog';
import { CustomerDialog } from './CustomerDialog';
import { OverrideDialog } from './OverrideDialog';
import { PinConfirmDialog } from './PinConfirmDialog';
import { DiscountReasonDialog } from './DiscountReasonDialog';
import { ShiftOpenDialog } from './ShiftOpenDialog';
import { ShiftCloseDialog } from './ShiftCloseDialog';
import { ReceiptPreview, type ReceiptLine } from './ReceiptPreview';
import { ReceiptPreviewDialog } from './ReceiptPreviewDialog';
import { TableSelectorDialog } from './TableSelectorDialog';
import { MoveItemsDialog } from './MoveItemsDialog';
import { SplitBillDialog } from './SplitBillDialog';

import { VoidItemDialog } from './VoidItemDialog';
import { CancelOrderDialog } from './CancelOrderDialog';
import { ReprintDialog } from './ReprintDialog';
import type { PosTable } from '@/features/tables/types';
import {
  statusMeta,
  zoneLabel as zoneLabelOf,
  zoneRankMap,
  compareZoneKeys,
  fmtMoney,
  minutesBetween,
} from '@/features/tables/utils';
import { useTables, useTransferItems, usePosTablesStream, useTableZones } from '@/features/tables/api';

import {
  useOpenSession,
  useCheckout,
  useSettleTab,
  useSaveTab,
  useStoreCredit,
  useFireKitchen,

  usePrintBill,
  usePrintKot,
  usePrintAdditionalBill,
  useReprintReceipt,
  useCreateOrder,
  useCreditInfo,
  useSplitState,
  useOrdersList,
  useResumeOrder,
  useSettleOrder,
  useSaveOrderItems,
  useCancelOrder,
  useVoidOrderItem,
  type OrderLineBody,
} from './api';
import { OrdersListPanel } from './OrdersListPanel';
import { useMenuItemsAvailable } from '@/features/menu/api';
import { useMenuItemBundle, useCombos } from './pos-features-api';
import { api, resolveAssetUrl } from '@/lib/api';
import { useCartStore, selectSubtotal, selectTotal } from '@/features/pos/cart.store';
import type { CartLine, DiscountType, PaymentTender } from '@/features/pos/types';
import { cartReadyToCommit } from '@/features/pos/cart-guard';
import type { Customer, SettleMode } from './types';

import { usePosAuthStore } from '@/features/pos/pos-auth.store';
import { usePosSettings } from '@/features/pos/api';
import { useScannerDebounce } from './scanner-debounce';
import PosLoginScreen from './PosLoginScreen';
import RetailTerminal from './RetailTerminal';
import RentalTerminal from './RentalTerminal';

import './pos-pro.css';

const fmt = (n: number | string) => `${useAuthStore.getState().organization?.currencyCode ?? 'IDR'} ${Number(n || 0).toLocaleString()}`;

/** Stable signature of an order's line-set — used to detect cart⇄server drift
 * so auto-save only fires on a real change (and never loops with the loader). */
const orderSig = (lines: CartLine[]) => cartSignature(lines) + JSON.stringify(draftPricing(useCartStore.getState())) + (useCartStore.getState().customer?.id ?? "");

/** Map a server order line (Document line) into a cart line. */

/** Map cart lines into printable receipt lines (modifier objects → names). */
function cartToReceiptLines(ls: CartLine[]): ReceiptLine[] {
  return ls.map((l) => ({
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountPercent: l.discountPercent,
    note: l.note,
    modifiers: l.modifiers?.map((m) => (m as any).kitchenPrintName ?? m.name).filter(Boolean),
    variantName: l.variantName,
    accompanimentNames: l.accompanimentNames,
  }));
}

/** Map a cart line into a checkout / save-tab line payload.
 *  Fixed-amount discounts are converted to equivalent percentage (API only
 *  stores discountPercent on DocumentLine). */
const cartLineToPayload = cartLinePayload;

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
        // basePrice is stored in whole currency units ({orgCur()}).
        salesPrice: it.basePrice != null ? Number(it.basePrice) : 0,
        categoryId: it.categoryId,
        category: it.categoryId ? { name: catName.get(it.categoryId) ?? '' } : null,
        // Signed URL resolved by PosMenuService.resolveImage; shown in MenuGrid.
        // Absolutize so the <img> loads from the API origin (dev proxy-less).
        image: resolveAssetUrl(it.image) ?? null,
      }));
  }, [menuPayload, activeCategory, search]);

  // Combos are fixed-price bundles managed separately (GET /pos/modifiers/combos).
  // They span categories, so we surface them only in the "All" view and let the
  // backend expand the `comboId` line into component rows at checkout.
  const { data: combos } = useCombos();
  const comboCards = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (combos ?? [])
      .filter(() => !activeCategory)
      .filter((c) => !term || c.name.toLowerCase().includes(term))
      .map((c) => ({
        id: c.id,
        name: c.name,
        sku: null,
        salesPrice: Number(c.price || 0),
        categoryId: null,
        category: null,
        image: resolveAssetUrl(c.imageUrl) ?? null,
        isCombo: true,
        comboSummary: c.items
          .map((it) => `${it.quantity > 1 ? `${it.quantity}× ` : ''}${it.productName}`)
          .join(' + '),
      }));
  }, [combos, activeCategory, search]);

  // Combos render first (they're specials), then the menu items.
  const gridItems = useMemo(() => [...comboCards, ...products], [comboCards, products]);

  /* ============== Shift ============== */
  const { data: session, isLoading: sessionLoading, isFetching: sessionFetching, refetch: refetchSession } = useOpenSession();
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);

  /* ============== Customer ============== */
  const customer: Customer | null = useCartStore((s) => s.customer);
  const setCustomer = useCartStore((s) => s.setCustomer);
  const [showCustomer, setShowCustomer] = useState(false);
  /* Redeemable store-credit balance for the selected customer (drives the
   * store_credit tender tile in PaymentDialog). */
  const { data: storeCredit } = useStoreCredit(customer?.id);
  /* House-account standing — drives the Charge dialog's credit panel. */
  const { data: creditInfo } = useCreditInfo(customer?.id);

  /* ============== Discounts ============== */
  const [showDiscount, setShowDiscount] = useState(false);
  const [lineForDiscount, setLineForDiscount] = useState<CartLine | null>(null);

  /* ============== Void item ============== */
  const [voidLine, setVoidLine] = useState<CartLine | null>(null);

  /* ============== Move Items ============== */
  const [showMoveItems, setShowMoveItems] = useState(false);

  /* ============== Split Bill ============== */
  const [showSplit, setShowSplit] = useState(false);

  /* ============== Move items ============== */
  const [transferBusy, setTransferBusy] = useState(false);

  /* ============== Cancel order ============== */
  const [showCancelOrder, setShowCancelOrder] = useState(false);
  const [cancelInvoice, setCancelInvoice] = useState<{ id: string; number: string } | null>(null);

  /* ============== Payment ============== */
  const [showPayment, setShowPayment] = useState(false);

  /* ============== Manager override ============== */
  const [overrideKind, setOverrideKind] = useState<'discount' | 'void' | 'manual_refund' | null>(null);
  const [overrideResolver, setOverrideResolver] = useState<((result: {managerId: string; pin: string} | null) => void) | null>(null);

  /* ============== PIN confirm (item delete) ============== */
  const [showPinConfirm, setShowPinConfirm] = useState(false);
  const [pendingRemoveLine, setPendingRemoveLine] = useState<CartLine | null>(null);

  /* ============== Discount reason (P4) ============== */
  const [showDiscountReason, setShowDiscountReason] = useState(false);

  /* ============== Receipt preview (Sprint P3) ============== */
  const [showBillPreview, setShowBillPreview] = useState(false);
  const [showKotPreview, setShowKotPreview] = useState(false);
  const [kotLines, setKotLines] = useState<CartLine[]>([]);
  const [kotCopy, setKotCopy] = useState(1);
  const [showAdditionalBillPreview, setShowAdditionalBillPreview] = useState(false);
  const [additionalBillLines, setAdditionalBillLines] = useState<CartLine[]>([]);
  const [additionalBillCopy, setAdditionalBillCopy] = useState(1);
  const [additionalBillPreviousSubtotal, setAdditionalBillPreviousSubtotal] = useState(0);
  const [additionalBillGrandTotal, setAdditionalBillGrandTotal] = useState(0);
  const [lastCompleted, setLastCompleted] = useState<{
    lines: ReceiptLine[]; total: number; discountPercent: number; discountAmount: number;
    orderTypeLabel?: string; tableLabel?: string; customerName?: string;
    invoiceNumber?: string; invoiceId?: string; receiptHtml?: string;
  } | null>(null);
  const canReprint = usePosAuthStore((s) => s.user?.permissions?.includes('pos:reports') ?? false);
  const canDeleteItem = usePosAuthStore((s) => s.user?.permissions?.includes('pos:delete_item') ?? false);
  const canVoidItem = usePosAuthStore((s) => s.user?.permissions?.includes('pos:void') ?? false);
  /* pos:discount gates the numpad % mode + Disc/Discount buttons, and is reused
   * as the price-override right (no dedicated pos:price_override permission). */
  const canDiscount = usePosAuthStore((s) => s.user?.permissions?.includes('pos:discount') ?? false);
  /* F-03 — the ONE discount-approval threshold, served by GET /pos/settings.
   * The terminal used to hardcode 10% / 50,000 here, which disagreed with the
   * org's configured value and pushed the rejection to the payment screen. */
  const { data: posSettings } = usePosSettings();
  const discountTier1 = Number(posSettings?.discountApproval?.tier1 ?? 10);
  /* Audit#2 N-06 — the absolute-amount tier; 0 means the org has not set one. */
  const discountTier1Amount = Number(posSettings?.discountApproval?.tier1Amount ?? 0);
  const [showReprint, setShowReprint] = useState<{ invoiceId: string; title: string } | null>(null);

  /* ============== Order type (Dine In / Takeaway / Delivery) ============== */
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

  /* ============== P4: 4-layer order flow (variant → accompaniment → add-ons → cart) ============== */
  const [pendingItem, setPendingItem] = useState<{
    productId: string;
    productName: string;
    sku: string | null;
    taxInclusive?: boolean;
    basePrice: number;
    variantId?: string;
    variantName?: string;
    variantPrice?: number;
    accompanimentOptionIds?: string[];
    accompanimentNames?: string[];
    accompanimentPriceImpact?: number;
  } | null>(null);

  const { data: pendingBundle } = useMenuItemBundle(pendingItem?.productId ?? null);

  const nextStep = useMemo<'variant' | 'accompaniment' | 'addons' | 'direct' | null>(() => {
    if (!pendingItem || !pendingBundle) return null;
    if (pendingBundle.variants.length > 0 && !pendingItem.variantId) return 'variant';
    if (pendingBundle.accompanimentGroups.length > 0 && !pendingItem.accompanimentOptionIds) return 'accompaniment';
    if (pendingBundle.groups.length > 0) return 'addons';
    return 'direct';
  }, [pendingItem, pendingBundle]);

  const cancelOrderFlow = useCallback(() => setPendingItem(null), []);

  const onVariantConfirm = useCallback((variantId: string, variantName: string, variantPrice: number) => {
    setPendingItem((prev) => (prev ? { ...prev, variantId, variantName, variantPrice } : prev));
  }, []);

  const onAccompanimentConfirm = useCallback((selections: Array<{ optionId: string; optionName: string; priceImpact: number }>) => {
    setPendingItem((prev) =>
      prev
        ? {
            ...prev,
            accompanimentOptionIds: selections.map((s) => s.optionId),
            accompanimentNames: selections.map((s) => s.optionName),
            accompanimentPriceImpact: selections.reduce((sum, s) => sum + s.priceImpact, 0),
          }
        : prev,
    );
  }, []);

  /** Compute the effective base price for AddOnsDialog = variantPrice ?? basePrice + accompanimentImpact */
  const effectiveBasePrice = useMemo(() => {
    if (!pendingItem) return 0;
    const base = pendingItem.variantPrice ?? pendingItem.basePrice;
    return base + (pendingItem.accompanimentPriceImpact ?? 0);
  }, [pendingItem]);

  const onAddAddOnsConfirm = useCallback(
    (input: {
      productId: string;
      productName: string;
      unitPrice: number;
      sku: string | null;
      modifiers: Array<{ modifierId: string; name: string; priceDelta: number }>;
      quantity: number;
      note: string;
      taxInclusive?: boolean;
    }) => {
      if (!pendingItem) return;
      useCartStore.getState().addLine({
        menuItemId: input.productId,
        sku: input.sku ?? undefined,
        name: input.productName,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        note: input.note || undefined,
        taxInclusive: input.taxInclusive,
        modifiers: input.modifiers.length > 0 ? input.modifiers : undefined,
        variantId: pendingItem.variantId,
        variantName: pendingItem.variantName,
        variantPrice: pendingItem.variantPrice,
        accompanimentOptionIds: pendingItem.accompanimentOptionIds,
        accompanimentNames: pendingItem.accompanimentNames,
        accompanimentPriceImpact: pendingItem.accompanimentPriceImpact,
      });
      setPendingItem(null);
    },
    [pendingItem],
  );

  /* ============== Fullscreen ============== */
  const [fullscreen, setFullscreen] = useState(false);

  const enterFullscreen = useCallback(() => {
    setFullscreen(true);
    document.body.classList.add('pos-terminal-fullscreen');
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  // Listen for browser-fullscreen-change to keep React state + body class in sync (ESC exit)
  useEffect(() => {
    const onFsChange = () => {
      const isFullscreen = !!document.fullscreenElement;
      setFullscreen(isFullscreen);
      document.body.classList.toggle('pos-terminal-fullscreen', isFullscreen);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /* ============== Cart (zustand) ============== */
  const lines = useCartStore((s) => s.lines);
  /* Reactive cart subtotal, so the discount dialog judges a fixed amount the
   * same way the server will (as a percentage of what the cart is worth). */
  const cartSubtotal = useCartStore(selectSubtotal);
  const transactionDiscountPercent = useCartStore((s) => s.transactionDiscountPercent);
  const transactionDiscountType = useCartStore((s) => s.transactionDiscountType);
  const transactionDiscountAmount = useCartStore((s) => s.transactionDiscountAmount);
  const transactionDiscountReason = useCartStore((s) => s.transactionDiscountReason);
  const estimatedTotal = useCartStore(selectTotal);
  const saleQuote = useSaleQuote();
  const total = saleQuote.data?.total ?? estimatedTotal;
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
  const orderId = useCartStore((s) => s.orderId);
  const setOrderId = useCartStore((s) => s.setOrderId);

  /* ============== Tables (live via SSE, fallback poll 20s) ============== */
  usePosTablesStream();
  const { data: tables = [], isLoading: tablesLoading } = useTables({ active: true, status: undefined });
  const { data: zones = [] } = useTableZones();

  /* Derived selected table � derived from selectedTableId + tables list */
  const selectedTable = selectedTableId
    ? tables.find((t) => t.id === selectedTableId) ?? null
    : null;

  /* ============== Per-table cart persistence ============== */
  const saveCurrentTableCart = useCallback(() => {
    const key = selectedTableId ?? 'walk-in';
    tableCartsRef.current.set(key, {
      lines: useCartStore.getState().lines,
      sentLineIds: Array.from(currentSentLineIds.current),
      transactionDiscountPercent: useCartStore.getState().transactionDiscountPercent,
      transactionDiscountType: useCartStore.getState().transactionDiscountType,
      transactionDiscountAmount: useCartStore.getState().transactionDiscountAmount,
    });
  }, [selectedTableId]);



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
  const printBill = usePrintBill();
  const printKot = usePrintKot();
  const printAdditionalBill = usePrintAdditionalBill();
  const reprintReceipt = useReprintReceipt();
  const transferItemsMut = useTransferItems();
  const createOrderMut = useCreateOrder();
  /* Odoo-style multi-order (Orders panel) — tableless walk-in/takeaway/delivery
   * orders persist as open Orders and are resumable; dine-in keeps its table tab. */
  const resumeOrderMut = useResumeOrder();
  const settleOrderMut = useSettleOrder();
  const saveOrderItems = useSaveOrderItems();
  const cancelOrderMut = useCancelOrder();
  const voidItemMut = useVoidOrderItem();
  const { data: ordersFeed } = useOrdersList({}, !!session);
  const ordersCount = ordersFeed?.count ?? 0;
  /* When a split is active on this table, the tab's lines are pinned server-side
   * (saveTab 400s). Used to suppress auto-save + redirect settle to the split. */
  const { data: splitState } = useSplitState(tableId ?? undefined, !!tableId);
  const splitActive = !!splitState?.splitActive;
  /* True while we're fetching+loading a table's order — gates auto-save so the
   * cleared/loading cart isn't pushed back to the server. */
  const [pendingTableLoad, setPendingTableLoad] = useState<string | null>(null);
  /* Signature of the line-set last synced to/from the server (guards the
   * load⇄auto-save loop: we only save when the cart differs from this). */
  const tabSyncSig = useRef<string>('');
  /* Odoo-style Orders panel + tableless-order auto-create/autosave bookkeeping. */
  const [showOrders, setShowOrders] = useState(false);
  const pendingOrderCreate = useRef(false);
  const orderSaveSig = useRef('');
  /* Auto-save concurrency. `saveTab.isPending` is read out of a render closure
   * and can be stale by the time a debounced timer fires: two auto-saves then
   * went out carrying the SAME optimistic-lock token and the second one was
   * rejected 409 by a server that had already applied the first — a conflict
   * the terminal invented against itself. A ref is read at fire time. */
  const saveInFlight = useRef(false);
  /* Anything typed while a save was in flight has to be pushed once it lands;
   * bumping this re-runs the auto-save effect. */
  const [saveTick, setSaveTick] = useState(0);
  /* Consecutive 409s. One is resolved silently; a stream of them means another
   * device really is editing this order, and auto-merging in a loop would fight
   * it, so we stop and tell the cashier. */
  const conflictStreak = useRef(0);

  /* A-016 — remember which server OrderItem each cart line is, so Void can
   * address it. Server lines come back in the order they were sent, which is
   * the same contract doMoveItems already relies on. Stored outside `lines` so
   * adopting ids never disturbs React keys, the numpad selection, or the cart
   * signature. */
  const adoptServerLines = useCallback((serverLines: any[], cartLines?: CartLine[]) => {
    const local = cartLines ?? useCartStore.getState().lines;
    const map: Record<string, string> = {};
    // Same index alignment carries the server's per-line attribution back onto
    // the cart, so a line rung by a colleague on another device shows THEIR
    // name here instead of this terminal's optimistic guess.
    const punched: Record<string, { punchedById?: string; punchedByName?: string }> = {};
    local.forEach((l, i) => {
      const srv = serverLines?.[i];
      if (srv?.id) map[l.lineId] = String(srv.id);
      if (srv?.punchedById || srv?.punchedByName) {
        punched[l.lineId] = { punchedById: srv.punchedById ?? undefined, punchedByName: srv.punchedByName ?? undefined };
      }
    });
    useCartStore.getState().setServerLineIds(map);
    if (Object.keys(punched).length) useCartStore.getState().stampPunchedBy(punched);
  }, []);

  /* ── Conflict recovery (409 on save) ──────────────────────────────────────
   * A save is refused when the version token the terminal holds is not the one
   * the server holds: another device edited this order first, or our token went
   * missing (a browser reload, an earlier save that failed). The terminal used
   * to toast "resolve the difference before charging" and KEEP the stale token,
   * so every later auto-save hit the identical 409 — the table was wedged until
   * the cashier navigated away and back, with nothing on screen saying so, and
   * no way to "resolve" anything.
   *
   * So resolve it instead of announcing it. Re-read the order the server really
   * holds, keep the lines this terminal typed but never managed to save (those
   * are exactly the ones with no server id), and re-arm the sync so the merged
   * set is pushed with a fresh token. Nothing is lost in either direction and
   * the cashier can charge.
   */
  const reconcileOrderConflict = useCallback(async (scope: { tableId?: string | null; orderId?: string | null }) => {
    const before = useCartStore.getState();
    const localOnly = before.lines.filter((l) => !before.serverLineIds[l.lineId]);
    let view: any = null;
    try {
      view = scope.tableId
        ? (await api.get(`/pos/tabs/${scope.tableId}`)).data
        : scope.orderId
          ? (await api.get(`/pos/orders/${scope.orderId}/resume`)).data
          : null;
    } catch {
      toast.error('Could not re-read this order. Your cart is preserved — try again.');
      return false;
    }
    // A table/order switch while we were fetching makes this answer stale.
    const st = useCartStore.getState();
    if (scope.tableId ? st.tableId !== scope.tableId : st.orderId !== scope.orderId) return false;

    // `completed` means billed, and a billed / closed / cancelled order refuses
    // every edit with the same 409 an optimistic-lock miss raises. A table read
    // simply answers null once its order is billed; the by-id resume does not,
    // so the status is what tells them apart.
    const editable = view?.id && !['completed', 'closed', 'cancelled'].includes(String(view.status ?? ''));
    if (!editable) {
      // Settled, cancelled or billed elsewhere. Unbind so the next save opens a
      // fresh order rather than retrying against one that no longer accepts
      // edits — a sale is never blocked.
      st.setOrderId(undefined);
      st.setTabVersion(undefined);
      st.setServerLineIds({});
      tabSyncSig.current = '__unsaved_draft__';
      orderSaveSig.current = '';
      toast.warning('That order was closed elsewhere. Your items are kept and will start a new order.');
      return true;
    }

    const serverLines = ((view.lines ?? []) as any[]).map(serverLineToCart);
    const merged = [...serverLines, ...localOnly];
    st.load(merged, draftRestore(view));
    st.setTabVersion(view.version);
    st.setOrderId(view.id);
    // Index-aligned: the server lines lead the merged set, so the unsaved local
    // tail simply has no id yet (it gets one on the next successful save).
    adoptServerLines(view.lines ?? [], merged);
    // Baseline is the SERVER's set, so the auto-save sees the local tail as
    // still-unsaved work and pushes it with the token we just adopted.
    const serverSig = orderSig(serverLines);
    if (scope.tableId) tabSyncSig.current = serverSig; else orderSaveSig.current = serverSig;
    toast.info(localOnly.length
      ? 'This order changed elsewhere — both versions were merged. Check it before charging.'
      : 'This order changed elsewhere — reloaded the current version.');
    return true;
  }, [adoptServerLines]);

  /* Flush the current order (table OR tableless) before switching away. */
  const flushCurrentOrder = useCallback(async () => {
    if (useCartStore.getState().operationPending) throw new Error('Resolve the pending payment before changing orders');
    if (saveInFlight.current || saveTab.isPending || saveOrderItems.isPending) throw new Error('Wait for the current order save to finish');
    if (pendingOrderCreate.current) throw new Error('Wait for the new order to finish saving');
    const st = useCartStore.getState();
    if (st.lines.length && !st.orderId && !st.tableId) throw new Error('This cart has not been saved. Keep it open until the server is available.');
    const sig = orderSig(st.lines);
    // A conflict here is resolved the same way the auto-save resolves it — merge
    // the two versions — but the caller is still stopped, because whatever it was
    // about to do (switch tables, open another order, charge) must be re-decided
    // against the merged order rather than the one the cashier was looking at.
    const onConflict = async (e: any, scope: { tableId?: string | null; orderId?: string | null }) => {
      if (e?.response?.status !== 409) throw e;
      await reconcileOrderConflict(scope);
      throw new Error('This order changed elsewhere and has been merged. Review it, then try again.');
    };
    if (st.tableId && sig !== tabSyncSig.current) {
      const saved: any = await saveTab.mutateAsync({ tableId: st.tableId, lines: st.lines.map(cartLineToPayload), partnerId: customer?.id, expectedVersion: st.tabVersion })
        .catch((e: any) => onConflict(e, { tableId: st.tableId }));
      if (useCartStore.getState().tableId === st.tableId) {
        useCartStore.getState().setTabVersion(saved.version);
        useCartStore.getState().setOrderId(saved.id);
        adoptServerLines(saved.lines ?? [], st.lines);
        tabSyncSig.current = sig;
      }
    } else if (st.orderId && sig !== orderSaveSig.current) {
      const saved: any = await saveOrderItems.mutateAsync({ orderId: st.orderId, lines: st.lines.map(cartLineToPayload) as OrderLineBody[], expectedVersion: st.tabVersion })
        .catch((e: any) => onConflict(e, { orderId: st.orderId }));
      if (useCartStore.getState().orderId === st.orderId) {
        useCartStore.getState().setTabVersion(saved.version);
        adoptServerLines(saved.items ?? saved.lines ?? [], st.lines);
        orderSaveSig.current = sig;
      }
    }
    if (orderSig(useCartStore.getState().lines) !== sig) throw new Error('The cart changed during save. Save the latest changes before continuing.');
  }, [saveTab, saveOrderItems, customer?.id, reconcileOrderConflict]);

  /* Imperatively fetch THIS table's open order fresh from the server and load it
   * into the cart. Deterministic — no react-query cache races on switch/return. */
  const loadTableOrder = useCallback(async (id: string) => {
    try {
      const doc = (await api.get(`/pos/tabs/${id}`)).data as any;
      const serverLines = (((doc?.lines) ?? []) as any[]).map(serverLineToCart);
      // Only apply if the cashier is still on this table (didn't switch again).
      if (useCartStore.getState().tableId === id) {
        useCartStore.getState().load(serverLines, draftRestore(doc));
        // H2 — remember the server version so saves carry the optimistic-lock token.
        useCartStore.getState().setTabVersion(doc?.version);
        // A-016 — the tab view carries its Order id and real line ids.
        useCartStore.getState().setOrderId(doc?.id);
        adoptServerLines(doc?.lines ?? [], serverLines);
        tabSyncSig.current = orderSig(serverLines);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not load the table. Your current cart is preserved.');
      throw e;
    } finally {
      setPendingTableLoad((cur) => (cur === id ? null : cur));
    }
  }, []);

  const handleTableClick = useCallback(async (t: PosTable) => {
    const previous = useCartStore.getState();
    if (previous.tableId === t.id) { setSelectedTableId(t.id); setTableView('ordering'); return; }
    try {
      await flushCurrentOrder();
      const switchingSignature = orderSig(useCartStore.getState().lines);
      setPendingTableLoad(t.id);
      const doc = (await api.get(`/pos/tabs/${t.id}`)).data as any;
      if (orderSig(useCartStore.getState().lines) !== switchingSignature) throw new Error('The cart changed while switching tables. Save it and try again.');
      const next = (doc?.lines ?? []).map(serverLineToCart);
      previous.clear(); previous.setTable(t.id, t.number, t.name); previous.load(next, draftRestore(doc)); previous.setTabVersion(doc?.version);
      previous.setOrderId(doc?.id);
      adoptServerLines(doc?.lines ?? [], next);
      tabSyncSig.current = orderSig(next);
      setSelectedTableId(t.id); setTableView('ordering'); enterFullscreen();
    } catch (e: any) { toast.error(e?.response?.data?.message || e?.message || 'Could not switch tables; current cart preserved'); }
    finally { setPendingTableLoad(null); }
  }, [flushCurrentOrder, enterFullscreen]);

  const handleNewOrder = handleTableClick;
  const handleContinueDraft = handleTableClick;

  const handleGoBackToGrid = useCallback(async () => {
    try { await flushCurrentOrder(); }
    catch (e: any) { toast.error(e?.response?.data?.message || e?.message); return; }
    saveCurrentTableCart(); setSelectedTableId(null); setTableView('grid');
  }, [saveCurrentTableCart, flushCurrentOrder]);

  /* Auto-save cart to tableCartsRef when leaving the OrderPanel view. */
  useEffect(() => {
    if (tableView === 'ordering') {
      return () => { saveCurrentTableCart(); };
    }
  }, [tableView, saveCurrentTableCart]);

  /* Switch order type: dine-in, takeaway, or delivery. When leaving dine-in
   * (table mode), flush any in-progress table cart and show menu directly. */
  const handleChangeOrderType = useCallback(async (type: 'dine-in' | 'takeaway' | 'delivery') => {
    try { await flushCurrentOrder(); }
    catch (e: any) { toast.error(e?.response?.data?.message || e?.message); return; }
    if (useCartStore.getState().tableId) { clearCart(); tabSyncSig.current = orderSig([]); }
    setOrderType(type); setTableView(type === 'dine-in' ? 'grid' : 'ordering'); setSelectedTableId(null);
  }, [clearCart, setOrderType, flushCurrentOrder]);

  /* ============== Mutations ============== */
  const checkout = useCheckout();

  /* On mount, baseline the sync signature and default order type. */
  useEffect(() => {
    const state = useCartStore.getState();
    tabSyncSig.current = state.lines.length ? '__unsaved_draft__' : orderSig([]);
    if (!state.orderType) useCartStore.getState().setOrderType('dine-in');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Auto-save: persist the cart back to the table's order whenever it changes
   * (debounced). No table selected = walk-in sale, no auto-save. */
  useEffect(() => {
    // While a split is active the tab is pinned (saveTab 400s) — never auto-save.
    if (!tableId || pendingTableLoad || splitActive) return;
    const currentSig = orderSig(lines);
    if (currentSig === tabSyncSig.current) return;
    const payloadLines = lines.map(cartLineToPayload);

    const h = setTimeout(async () => {
      if (useCartStore.getState().operationPending) return;
      // One save at a time, decided at fire time — see `saveInFlight`.
      if (saveInFlight.current) { setSaveTick((n) => n + 1); return; }
      saveInFlight.current = true;
      // Only a save that got somewhere re-arms the loop. A save that failed for
      // any other reason (API down, offline) waits for the next cart change, or
      // an unreachable server would be retried — and toasted — every 700ms.
      let rearm = false;
      try {
        const version = useCartStore.getState().tabVersion;
        // A saved order with no token in hand: the server refuses to replace the
        // items of an order it can't version-check (409, worded as a conflict).
        // Fetch the token instead of walking into that.
        if (version == null && useCartStore.getState().orderId) {
          rearm = await reconcileOrderConflict({ tableId });
          return;
        }
        const saved: any = await saveTab.mutateAsync({ tableId, lines: payloadLines, partnerId: customer?.id, expectedVersion: version });
        if (useCartStore.getState().tableId === tableId) {
          useCartStore.getState().setTabVersion(saved?.version);
          useCartStore.getState().setOrderId(saved?.id);
          adoptServerLines(saved?.lines ?? []);
          tabSyncSig.current = currentSig;
        }
        conflictStreak.current = 0;
        rearm = true;
      } catch (e: any) {
        if (e?.response?.status !== 409) {
          toast.error(e?.response?.data?.message || 'Order save failed; your cart is preserved');
        } else if ((conflictStreak.current += 1) > 3) {
          toast.error('This order keeps changing on another device. Reopen the table before charging.');
        } else {
          rearm = await reconcileOrderConflict({ tableId });
        }
      } finally {
        saveInFlight.current = false;
        // Whatever was typed while that save was in flight still needs pushing.
        if (rearm && orderSig(useCartStore.getState().lines) !== tabSyncSig.current) setSaveTick((n) => n + 1);
      }
    }, 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, tableId, pendingTableLoad, customer?.id, splitActive, transactionDiscountPercent, transactionDiscountType, transactionDiscountAmount, transactionDiscountReason, saveTick]);

  const locked = !sessionLoading && !session && !sessionFetching;
  const orderTypeFromStore = useCartStore((s) => s.orderType);

  /* ── Odoo-style tableless multi-order (takeaway / delivery walk-ins) ──────
   * Dine-in persists via the table tab above. For a tableless order we mirror it:
   * auto-create an open Order on the first item so it's resumable from the Orders
   * panel, autosave it, and settle it by id. Best-effort — an offline create just
   * keeps the local cart (settles via checkout), so a sale is never blocked. */
  useEffect(() => {
    if (locked || tableId || orderId || pendingOrderCreate.current) return;
    if (lines.length === 0 || orderTypeFromStore === 'dine-in') return;
    pendingOrderCreate.current = true;
    const creatingSignature = orderSig(useCartStore.getState().lines);
    createOrderMut.mutateAsync({
      orderType: orderTypeFromStore === 'delivery' ? 'delivery' : 'takeaway',
      partnerId: customer?.id,
      cashSessionId: session?.id,
      guestCount: 1,
      lines: useCartStore.getState().lines.map(cartLineToPayload) as OrderLineBody[],
    }).then((order) => {
      const st = useCartStore.getState();
      if (!st.orderId && !st.tableId && st.lines.length > 0) {
        st.setOrderId((order as any).id);
        st.setTabVersion((order as any).version);
        adoptServerLines((order as any)?.items ?? [], st.lines);
        orderSaveSig.current = creatingSignature;
      }
    }).catch(() => { /* offline / failed — keep local cart, settle via checkout */ })
      .finally(() => { pendingOrderCreate.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, orderId, tableId, locked, orderTypeFromStore, customer?.id, session?.id]);

  useEffect(() => {
    if (!orderId || tableId) return; // tableless only; tables use the tab autosave
    const sig = orderSig(lines);
    if (sig === orderSaveSig.current) return;
    const t = setTimeout(async () => {
      const st = useCartStore.getState();
      if (st.orderId !== orderId || st.tableId || st.operationPending) return;
      if (saveInFlight.current) { setSaveTick((n) => n + 1); return; }
      if (st.lines.length === 0) {
        try { await cancelOrderMut.mutateAsync({ orderId, reason: 'Order emptied' }); } catch { toast.error('Could not save the empty order'); return; }
        if (useCartStore.getState().orderId === orderId) { setOrderId(undefined); useCartStore.getState().setTabVersion(undefined); }
        orderSaveSig.current = '';
        return;
      }
      saveInFlight.current = true;
      let rearm = false;
      try {
        // Same rule as the tab auto-save: replacing a saved order's items needs
        // a version token, and asking without one is refused as a conflict.
        if (st.tabVersion == null) {
          rearm = await reconcileOrderConflict({ orderId });
          return;
        }
        const saved = await saveOrderItems.mutateAsync({ orderId, lines: st.lines.map(cartLineToPayload) as OrderLineBody[], expectedVersion: st.tabVersion });
        if (useCartStore.getState().orderId === orderId) {
          if (typeof (saved as any)?.version === 'number') useCartStore.getState().setTabVersion((saved as any).version);
          adoptServerLines((saved as any)?.items ?? (saved as any)?.lines ?? [], st.lines);
        }
        orderSaveSig.current = sig;
        conflictStreak.current = 0;
        rearm = true;
      } catch (e: any) {
        if (e?.response?.status !== 409) {
          // This used to be swallowed: the order silently stopped saving and the
          // cashier found out at the till.
          toast.error(e?.response?.data?.message || 'Order save failed; your cart is preserved');
        } else if ((conflictStreak.current += 1) > 3) {
          toast.error('This order keeps changing on another device. Reopen it from the Orders panel before charging.');
        } else {
          rearm = await reconcileOrderConflict({ orderId });
        }
      } finally {
        saveInFlight.current = false;
        if (rearm && orderSig(useCartStore.getState().lines) !== orderSaveSig.current) setSaveTick((n) => n + 1);
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, orderId, tableId, transactionDiscountPercent, transactionDiscountType, transactionDiscountAmount, transactionDiscountReason, customer?.id, saveTick]);

  /* New tableless order — the current one stays open in the Orders panel. */
  const newTablelessOrder = useCallback(async () => {
    try { await flushCurrentOrder(); } catch (e: any) { toast.error(e?.response?.data?.message || e?.message); return; }
    clearCart();
    orderSaveSig.current = '';
    tabSyncSig.current = orderSig([]);
    setSelectedTableId(null);
    setOrderType('takeaway');
    setTableView('ordering');
    setShowOrders(false);
  }, [flushCurrentOrder, clearCart, setOrderType]);

  /* Resume any order from the panel. A dine-in order routes back to its table
   * (reusing handleTableClick); a tableless one loads into the ordering view. */
  const openOrder = useCallback(async (id: string) => {
    setShowOrders(false);
    if (useCartStore.getState().orderId === id) return;
    try {
      await flushCurrentOrder();
      const switchingSignature = orderSig(useCartStore.getState().lines);
      const view: any = await resumeOrderMut.mutateAsync(id);
      if (orderSig(useCartStore.getState().lines) !== switchingSignature) throw new Error('The cart changed while opening the order. Your changes are preserved.');
      if (view.tableId) {
        const t = tables.find((x) => x.id === view.tableId);
        if (t) { handleTableClick(t); return; }
      }
      const cartLines = (view.lines ?? []).map(serverLineToCart);
      clearCart();
      setOrderType(view.orderType === 'delivery' ? 'delivery' : 'takeaway');
      useCartStore.getState().load(cartLines, draftRestore(view));
      setOrderId(id);
      useCartStore.getState().setTabVersion(view.version);
      adoptServerLines(view.lines ?? [], cartLines);
      orderSaveSig.current = orderSig(cartLines);
      setSelectedTableId(null);
      setTableView('ordering');
      enterFullscreen();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not open order');
    }
  }, [flushCurrentOrder, resumeOrderMut, clearCart, setOrderType, setOrderId, tables, handleTableClick, enterFullscreen]);

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

  const ORDER_TYPE_LABELS: Record<string, string> = { 'dine-in': 'Dine In', takeaway: 'Takeaway', delivery: 'Delivery' };
  const orderTypeLabel = orderTypeFromStore ? ORDER_TYPE_LABELS[orderTypeFromStore] ?? 'Dine In' : 'Dine In';
  const activeTableLabel = selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : null;
  const [showTableSelector, setShowTableSelector] = useState(false);

  /* ============== Catalog actions ============== */
  const onPickProduct = useCallback(
    (p: any) => {
      if (locked) return;
      // Combo card → single combo line (no variant/accompaniment/add-on steps).
      // The backend expands `comboId` into component rows at checkout.
      if (p.isCombo) {
        addLine({
          productId: p.id,
          name: p.name,
          quantity: 1,
          unitPrice: Number(p.salesPrice || 0),
          comboId: p.id,
        });
        return;
      }
      // Start the 4-layer order flow (variant → accompaniment → add-ons → cart).
      // The bundle fetch determines which steps to show; nextStep resolves below.
      setPendingItem({
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        basePrice: Number(p.salesPrice || 0),
        taxInclusive: p.taxInclusive,
      });
    },
    [locked, addLine],
  );

  /* When no customization steps exist, add directly to cart. */
  useEffect(() => {
    if (nextStep !== 'direct' || !pendingItem) return;
    addLine({
      menuItemId: pendingItem.productId,
      sku: pendingItem.sku ?? undefined,
      name: pendingItem.productName,
      quantity: 1,
      unitPrice: pendingItem.basePrice,
      taxInclusive: pendingItem.taxInclusive,
      variantId: pendingItem.variantId,
      variantName: pendingItem.variantName,
      variantPrice: pendingItem.variantPrice,
      accompanimentOptionIds: pendingItem.accompanimentOptionIds,
      accompanimentNames: pendingItem.accompanimentNames,
      accompanimentPriceImpact: pendingItem.accompanimentPriceImpact,
    });
    setPendingItem(null);
  }, [nextStep, pendingItem, addLine]);

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

  /* F-07 — ONE scan pipeline, mirroring RetailTerminal.
   *
   * There used to be two: an undebounced effect that matched on every keystroke,
   * plus this debounced one, both racing the same input. Neither asked the
   * server, so anything outside the loaded menu page could not be scanned at
   * all — and an unrecognised code did nothing whatsoever, which reads to a
   * cashier as a broken scanner. The loaded menu is now only a fast path;
   * `/pos/lookup` is the authority, and a miss says so out loud.
   *
   * `scanSeq` drops a stale lookup if a newer scan started while it was in
   * flight. */
  const scanSeq = useRef(0);
  const onScan = useCallback(async (code: string) => {
    if (locked) return;
    const seq = ++scanSeq.current;
    const local = (products as any[]).find(
      (p) => p.sku && p.sku.toLowerCase() === code.toLowerCase(),
    );
    if (local) { onPickProduct(local); setSearch(''); return; }
    try {
      const res: any = await api.get('/pos/lookup', { params: { sku: code } });
      if (seq !== scanSeq.current) return; // superseded by a newer scan
      const rows = Array.isArray(res.data) ? res.data : [res.data];
      const hit = rows.find((r: any) => r && r.id);
      if (!hit) { toast.error(`No item matches "${code.slice(0, 24)}"`); setSearch(''); return; }
      onPickProduct({
        id: hit.id,
        name: hit.name,
        sku: hit.sku ?? null,
        salesPrice: Number(hit.salesPrice ?? 0),
        taxInclusive: hit.taxInclusive,
      });
      setSearch('');
    } catch {
      if (seq === scanSeq.current) toast.error('Could not look that code up — check the connection and try again');
    }
  }, [products, onPickProduct, locked]);
  useScannerDebounce(search, onScan);

  const onInc = (line: CartLine) => setQuantity(line.lineId, line.quantity + 1);
  const onDec = (line: CartLine) => setQuantity(line.lineId, line.quantity - 1);
  /* ============== Manager override helper ============== */
  const requestOverride = useCallback((kind: 'discount' | 'void' | 'manual_refund'): Promise<{managerId: string; pin: string} | null> => {
    return new Promise<{managerId: string; pin: string} | null>((resolve) => {
      setOverrideKind(kind);
      setOverrideResolver(() => resolve);
    });
  }, []);

  const onOverrideVerified = (result: {managerId: string; pin: string} | null) => {
    if (overrideResolver) overrideResolver(result);
    setOverrideKind(null);
    setOverrideResolver(null);
  };

  /* ============== Taking a line off the order ==============
   * Delete and Void are the same act with different words on the button, so
   * they run the same way: a reason and the operator's own PIN are collected
   * up front, then the line is voided THROUGH the server whenever the server
   * already knows about it, so the order keeps a permanent record of what was
   * ordered, who took it off and why, and the kitchen board loses the ticket.
   * A line that has never been saved has no such history to keep: it is
   * dropped locally, exactly as it was typed. */
  const voidLineOnServer = useCallback(async (lineId: string, reason: string) => {
    const st = useCartStore.getState();
    const serverItemId = st.serverLineIds[lineId];
    const targetOrderId = st.orderId;
    if (!serverItemId || !targetOrderId) {
      removeLine(lineId);
      toast.success('Item removed');
      return;
    }
    const send = async (override?: { managerId: string; pin: string }) =>
      voidItemMut.mutateAsync({
        orderId: targetOrderId, itemId: serverItemId, reason,
        overrideById: override?.managerId, overridePin: override?.pin,
      });
    try {
      let view: any;
      try {
        view = await send();
      } catch (e: any) {
        // The server refuses an unapproved void of food the kitchen has
        // already been told to cook. Collect the manager PIN and retry.
        const msg = e?.response?.data?.message || '';
        if (e?.response?.status !== 403 || !/manager approval/i.test(msg)) throw e;
        const approval = await requestOverride('void');
        if (!approval) { toast.error('Manager approval cancelled — the item is still on the order'); return; }
        view = await send(approval);
      }
      // Re-read so the cart matches the order the server now holds (quantities,
      // totals, remaining line ids and the fresh version token).
      //
      // Not from the void response: that is the RAW order, whose unit prices
      // still have the variant / accompaniment / modifier charge folded in and
      // whose note is the folded KOT form. Rebuilding the cart from that shape
      // dropped `accompanimentPriceImpact` to 0, so the next auto-save sent a
      // unit price that still contained the accompaniment charge and the server
      // added it a second time — the line silently got dearer after a void. The
      // terminal's own tab view un-folds all of it.
      let fresh: any = null;
      try {
        fresh = tableId
          ? (await api.get(`/pos/tabs/${tableId}`)).data
          : (await api.get(`/pos/orders/${targetOrderId}/resume`)).data;
      } catch { /* the void itself committed; fall back to its answer */ }
      const source: any[] = (fresh?.lines ?? view?.items ?? view?.lines ?? []) as any[];
      const serverLines = source.map(serverLineToCart);
      useCartStore.getState().load(serverLines, draftRestore(fresh ?? view));
      useCartStore.getState().setTabVersion(fresh?.version ?? view?.version);
      useCartStore.getState().setOrderId(fresh?.id ?? targetOrderId);
      adoptServerLines(source, serverLines);
      if (tableId) tabSyncSig.current = orderSig(serverLines);
      else orderSaveSig.current = orderSig(serverLines);
      toast.success('Item voided');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Could not void the item');
    }
  }, [removeLine, voidItemMut, requestOverride, adoptServerLines, tableId]);

  const onRemove = (line: CartLine) => {
    setPendingRemoveLine(line);
    setShowPinConfirm(true);
  };
  const onPinVerified = async (reason: string) => {
    const line = pendingRemoveLine;
    setShowPinConfirm(false);
    setPendingRemoveLine(null);
    if (line) await voidLineOnServer(line.lineId, reason);
  };
  const onLineDiscount = (line: CartLine) => setLineForDiscount(line);
  const onLineDiscountApply = (lineId: string, amount: number, type?: DiscountType, reason?: string) => {
    setDiscount(lineId, amount, type, reason);
    if (amount > 0) {
      toast.success(type === 'fixed_amount' ? `Line discount ${fmt(amount)} applied` : `Line discount ${amount}% applied`);
    } else {
      toast.success('Line discount cleared');
    }
  };
  const onLineNote = (line: CartLine) => {
    const next = window.prompt(`Note for "${line.name}"`, line.note ?? '');
    if (next !== null) setNote(line.lineId, next);
  };

  /* ============== Order-level discount ============== */
  const onApplyOrderDiscount = (percent: number) => {
    onApplyOrderDiscountEx(percent, 'percentage');
  };
  const onApplyOrderDiscountEx = (amount: number, type: DiscountType) => {
    // F-03 — a fixed amount is judged the way the server judges it: as a
    // percentage of what the cart is actually worth, against the org's own
    // threshold. The old rule compared UGX 50,000 to a currency-blind constant.
    const sub = selectSubtotal(useCartStore.getState());
    const asPercent = type === 'fixed_amount' ? (sub > 0 ? (amount / sub) * 100 : 0) : amount;
    const givenAway = type === 'fixed_amount' ? amount : (sub * amount) / 100;
    const needsOverride = amount > 0 && (
      !canDiscount
      || asPercent > discountTier1
      || (discountTier1Amount > 0 && givenAway > discountTier1Amount)
    );
    const label = type === 'fixed_amount' ? `${fmt(amount)} discount` : `${amount}% discount`;
    if (needsOverride) {
      requestOverride('discount').then((result) => {
        if (!result) {
          toast.error('Manager override cancelled');
          return;
        }
        setTransactionDiscount(amount, type);
        useCartStore.setState({ overrideById: result.managerId, overridePin: result.pin });
        if (amount > 0) setShowDiscountReason(true);
        toast.success(`${label} applied with override`);
      });
    } else {
      setTransactionDiscount(amount, type);
      if (amount > 0) setShowDiscountReason(true);
      toast.success(`${label} applied`);
    }
  };

  /* ============== Charge (payment) ============== */
  const onCharge = () => {
    if (!saleQuote.data || saleQuote.isFetching || saleQuote.isError) { toast.error('Wait for the server price quote before charging'); return; }
    if (pendingOrderCreate.current) { toast.info('Saving the new order; try again shortly'); return; }
    if (!cartReadyToCommit(lines)) return;
    setShowPayment(true);
  };

  /* Settle (pay) the table's order. Flush any pending edit, then open payment. */
  const handleSettleTab = async () => {
    if (!tableId) { toast.error('Nothing to settle'); return; }
    if (!cartReadyToCommit(lines)) return;
    try {
      if (splitActive) {
        if (orderSig(useCartStore.getState().lines) !== tabSyncSig.current) throw new Error('Unsaved changes must be resolved before reopening the split.');
        setShowSplit(true); return;
      }
      await flushCurrentOrder();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Could not save the order before settling');
      return;
    }
    setIsTabSettle(true);
    setShowPayment(true);
  };

  /* Transfer selected items to another table. We flush the cart first so the
   * server draft's line ids line up 1:1 with the on-screen order, then map our
   * selection (made against cart lineIds) onto the canonical server line ids
   * before moving them. Finally we reload THIS table to show the remainder. */
  /* Move Items — invoked by MoveItemsDialog after step 2 (destination + selection). */
  const doMoveItems = useCallback(async (targetId: string, selection: Array<{ lineId: string; quantity: number }>) => {
    if (!tableId || !selection.length) return;
    setTransferBusy(true);
    try {
      const currentLines = useCartStore.getState().lines;
      const saved = await saveTab.mutateAsync({ tableId, lines: currentLines.map(cartLineToPayload), partnerId: customer?.id, expectedVersion: useCartStore.getState().tabVersion });
      tabSyncSig.current = orderSig(currentLines);
      const serverLines: any[] = (saved as any)?.lines ?? [];
      useCartStore.getState().setTabVersion((saved as any)?.version);
      adoptServerLines(serverLines, currentLines);
      const items = selection
        .map((s) => {
          const idx = currentLines.findIndex((l) => l.lineId === s.lineId);
          const srv = idx >= 0 ? serverLines[idx] : undefined;
          return srv ? { lineId: srv.id as string, quantity: s.quantity } : null;
        })
        .filter((x): x is { lineId: string; quantity: number } => x != null);
      if (items.length === 0) { toast.error('Could not match the selected items to the saved order'); return; }
      const res = await transferItemsMut.mutateAsync({ sourceId: tableId, targetId, items });
      const moved = ((res as any)?.movedSummary ?? []).reduce((s: number, i: any) => s + Number(i.quantity), 0);
      const dest = tables.find((t) => t.id === targetId);
      toast.success(`Moved ${moved} item(s) to T${dest?.number ?? ''}`);
      setShowMoveItems(false);
      setPendingTableLoad(tableId);
      tabSyncSig.current = '__loading__';
      await loadTableOrder(tableId);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Move failed');
    } finally {
      setTransferBusy(false);
    }
  }, [tableId, saveTab, customer?.id, transferItemsMut, tables, loadTableOrder]);

  /* Credit / charge-to-account sale.
   *
   * This is the SAME settle the cashier does for cash — only the settle mode
   * differs, so it goes through onSettle and therefore through whichever of the
   * three server paths already owns this cart (open tab / open order / cart
   * checkout). It used to build a second Order of its own, which left the
   * original one open, kept the table busy and skipped the idempotency key. */
  const onCreditSale = async () => {
    if (!customer?.id) { toast.error('Select a customer to charge on account'); return; }
    if (!cartReadyToCommit(lines)) return;
    await onSettle({ tenders: [], transactionDiscountPercent: 0, settleMode: 'credit' });
  };

  /* A promise-shaped discount-reason prompt, mirroring requestOverride, so the
   * settle path can ask for the one thing the server is missing and retry —
   * instead of dead-ending at the payment screen (F-02). */
  const [reasonResolver, setReasonResolver] = useState<((r: string | null) => void) | null>(null);
  const requestDiscountReason = useCallback((): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setReasonResolver(() => resolve);
      setShowDiscountReason(true);
    });
  }, []);
  const settleDiscountReason = useCallback((reason: string | null) => {
    if (reasonResolver) reasonResolver(reason);
    setReasonResolver(null);
    setShowDiscountReason(false);
  }, [reasonResolver]);

  /* F-05 — a settle that never reached the server is QUEUED, not failed.
   * "Settle failed" for a dropped connection is the one message a cashier must
   * never be given: the write-ahead queue is about to post the sale, so they
   * either release the customer unpaid or take the money a second time. */
  const notifySettleFailure = useCallback((e: any) => {
    if (!e?.response) {
      toast.warning('Saved — this sale posts as soon as the connection returns. Do not ring it again.');
      return;
    }
    const status = Number(e.response.status);
    if (status >= 500 || status === 408) {
      toast.warning('Payment not confirmed. Recover the original attempt before starting another sale.');
      return;
    }
    // A genuine 4xx: nothing committed and the cart is intact, so the message
    // the server sent is the whole story — the caller surfaces it.
  }, []);

  /* F-02/F-03 — the server rejects a discount for exactly two fixable reasons:
   * it wants a reason, or it wants a manager. Offer the fix and retry rather
   * than leaving the cashier stuck at Charge. Returns true when it retried. */
  const recoverFromPricingRejection = useCallback(async (
    msg: string,
    input: any,
    retry: (i: any) => Promise<void>,
  ): Promise<boolean> => {
    if (/discount reason is required/i.test(msg)) {
      const reason = await requestDiscountReason();
      if (!reason) { toast.error('A discount reason is required to complete this sale'); return false; }
      useCartStore.setState({ transactionDiscountReason: reason });
      await retry(input);
      return true;
    }
    if (/manager (override|approval)/i.test(msg) && !input.overrideById) {
      const result = await requestOverride('discount');
      if (!result) return false;
      await retry({ ...input, overrideById: result.managerId, overridePin: result.pin });
      return true;
    }
    return false;
  }, [requestDiscountReason, requestOverride]);

  const onSettle = async (input: { tenders: PaymentTender[]; transactionDiscountPercent: number; amountTendered?: number; overrideById?: string; overridePin?: string; settleMode?: SettleMode }) => {
    if (!saleQuote.data || saleQuote.isError || saleQuote.isFetching) throw new Error('A current server price quote is required before payment');
    const isCredit = input.settleMode === 'credit';
    /* Credit collects nothing, so there is no change to announce — say who now
     * owes what instead. */
    const settledToast = (invoiceNumber?: string) => {
      if (isCredit) return `Charged ${fmt(total)} to ${customer?.name ?? 'account'} — due later`;
      return invoiceNumber ? `Order ${invoiceNumber} settled` : 'Order settled';
    };
    /* Compute effective transaction discount percent (handles fixed-amount). */
    const effectiveTxPct = transactionDiscountType === 'fixed_amount' && transactionDiscountAmount > 0
      ? (() => { const sub = selectSubtotal(useCartStore.getState()); return sub > 0 ? Math.min(100, (transactionDiscountAmount / sub) * 100) : 0; })()
      : transactionDiscountPercent;
    /* One stable Idempotency-Key per cart — reused across every settle attempt
     * (online retries + offline replay) so a lost response never double-charges.
     * clear()/load() mint a fresh key once this sale is done. */
    const idemKey = useCartStore.getState().idempotencyKey;
    /* M4: settle the accumulated server tab instead of cart-checkout */
    if (isTabSettle && tableId) {
      const finishSettle = () => {
        setIsTabSettle(false);
        tabSyncSig.current = '';
        clearCart();
        setCustomer(null);
        setShowPayment(false);
        setSelectedTableId(null);
        setTableView('grid');
        refetchSession();
        currentSentLineIds.current.clear();
      };
      try {
        await flushCurrentOrder();
        const res = await settleTabMut.mutateAsync({
          tableId,
          overrideById: input.overrideById, overridePin: input.overridePin,
          tenders: input.tenders,
          amountTendered: input.amountTendered,
          transactionDiscountPercent: effectiveTxPct,
          transactionDiscountType: transactionDiscountType !== 'percentage' ? transactionDiscountType : undefined,
          transactionDiscountAmount: transactionDiscountType === 'fixed_amount' ? transactionDiscountAmount : undefined,
          discountReason: transactionDiscountReason,
          cashSessionId: session?.id,
          settleMode: input.settleMode,
          partnerId: customer?.id,
          _idemKey: idemKey,
          expectedTotal: total,
          expectedVersion: useCartStore.getState().tabVersion,
        });
        toast.success(isCredit
          ? settledToast()
          : `Order settled — change ${fmt((res as any).change ?? 0)}`);
        // Pop the settlement receipt so the cashier can print it.
        setLastCompleted({
          lines: cartToReceiptLines(lines),
          total,
          invoiceNumber: (res as any).invoiceNumber,
          invoiceId: (res as any).invoiceId,
          receiptHtml: (res as any).receiptHtml,
          discountPercent: effectiveTxPct,
          discountAmount: 0,
          orderTypeLabel: orderTypeLabel ?? undefined,
          tableLabel: activeTableLabel ?? undefined,
          customerName: customer?.name,
        });
        finishSettle();
      } catch (e: any) {
        const msg = e?.response?.data?.message || e?.message || 'Settle failed';
        if (await recoverFromPricingRejection(msg, input, onSettle)) return;
        notifySettleFailure(e);
        if (e?.response && Number(e.response.status) < 500) toast.error(msg);
        throw e;
      }
      return;
    }

    /* Tableless open order (auto-created takeaway/delivery) → settle by id. No new
     * order is created; falls through to checkout only when there's no server order
     * (offline auto-create skipped), so a sale is never blocked. */
    const activeOrderId = useCartStore.getState().orderId;
    if (activeOrderId && !tableId) {
      try {
        await flushCurrentOrder();
        const res: any = await settleOrderMut.mutateAsync({
          orderId: activeOrderId,
          tenders: input.tenders,
          amountTendered: input.amountTendered,
          transactionDiscountPercent: effectiveTxPct,
          transactionDiscountType: transactionDiscountType !== 'percentage' ? transactionDiscountType : undefined,
          transactionDiscountAmount: transactionDiscountType === 'fixed_amount' ? transactionDiscountAmount : undefined,
          discountReason: transactionDiscountReason,
          overrideById: input.overrideById,
          overridePin: input.overridePin,
          cashSessionId: session?.id,
          settleMode: input.settleMode,
          partnerId: customer?.id,
          _idemKey: idemKey,
          expectedTotal: total,
          expectedVersion: useCartStore.getState().tabVersion,
        });
        toast.success(isCredit
          ? settledToast(res.invoiceNumber)
          : `Order ${res.invoiceNumber} settled — change ${fmt(res.change ?? 0)}`);
        setLastCompleted({
          lines: cartToReceiptLines(lines),
          total, invoiceNumber: res.invoiceNumber, invoiceId: res.invoiceId,
          receiptHtml: res.receiptHtml,
          discountPercent: effectiveTxPct, discountAmount: 0,
          orderTypeLabel: orderTypeLabel ?? undefined,
          customerName: customer?.name,
        });
        clearCart();
        setCustomer(null);
        setShowPayment(false);
        refetchSession();
      } catch (e: any) {
        const msg = e?.response?.data?.message || e?.message || 'Settle failed';
        if (await recoverFromPricingRejection(msg, input, onSettle)) return;
        notifySettleFailure(e);
        if (e?.response && Number(e.response.status) < 500) toast.error(msg);
        throw e;
      }
      return;
    }

    const checkoutLines = lines.map((l) => {
      const base = l.quantity * l.unitPrice;
      const pct = l.discountType === 'fixed_amount' && l.discountAmount
        ? base > 0 ? Math.min(100, (l.discountAmount / base) * 100) : 0
        : l.discountPercent;
      return {
        productId: l.productId,
        menuItemId: l.menuItemId,
        sku: l.sku,
        description: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxId: l.taxId,
        discountPercent: pct > 0 ? pct : undefined,
        discountType: l.discountType,
        discountAmount: l.discountAmount,
        discountReason: l.discountReason,
        note: l.note,
        modifiers: l.modifiers && l.modifiers.length > 0 ? l.modifiers : undefined,
        comboId: l.comboId,
        taxInclusive: l.taxInclusive,
        variantId: l.variantId,
        accompanimentOptionIds: l.accompanimentOptionIds,
      };
    });
    const payload = {
      lines: checkoutLines,
      expectedTotal: total,
      tenders: input.tenders,
      amountTendered: input.amountTendered,
      transactionDiscountPercent: effectiveTxPct,
      transactionDiscountType: transactionDiscountType !== 'percentage' ? transactionDiscountType : undefined,
      transactionDiscountAmount: transactionDiscountType === 'fixed_amount' ? transactionDiscountAmount : undefined,
      discountReason: transactionDiscountReason,
      overrideById: input.overrideById,
      overridePin: input.overridePin,
      cashSessionId: session?.id,
      branchId: undefined,
      reference: undefined,
      partnerId: customer?.id,
      // Tables (ADR-012): tie the sale to the active table when present.
      tableId: tableId || undefined,
      orderType: orderTypeFromStore === 'dine-in' ? 'dine_in' : orderTypeFromStore === 'takeaway' ? 'takeaway' : 'delivery',
      guestCount: undefined as number | undefined,
      settleMode: input.settleMode,
    } as any;
    try {
      const res = await checkout.mutateAsync({ ...payload, _idemKey: idemKey });
      toast.success(isCredit
        ? settledToast(res.invoiceNumber)
        : `Sale ${res.invoiceNumber} settled — change ${fmt(res.change)}`);

      setLastCompleted({
        lines: cartToReceiptLines(lines),
        total, invoiceNumber: res.invoiceNumber, invoiceId: res.invoiceId,
        receiptHtml: res.receiptHtml,
        discountPercent: effectiveTxPct,
        discountAmount: effectiveTxPct > 0 ? total - lines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0) : 0,
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
      if (await recoverFromPricingRejection(msg, input, onSettle)) return;
      notifySettleFailure(e);
      if (e?.response && Number(e.response.status) < 500) toast.error(msg);
      throw e;
    }
  };

  /* ============== Hold ============== */
  /* ============== Bill / KOT preview ============== */
  const resolveOpenOrder = async (): Promise<{ orderId: string; billPrintCount: number } | null> => {
    const open = selectedTable?.orders?.find((o) => !o.closedAt);
    if (open?.orderId) {
      return { orderId: open.orderId, billPrintCount: Number(open.order?.billPrintCount ?? 0) };
    }
    if (tableId) {
      try {
        const order = await api.get(`/pos/orders/by-table/${tableId}`).then((r: any) => r.data);
        if (order?.id) {
          return { orderId: order.id, billPrintCount: Number(order.billPrintCount ?? 0) };
        }
      } catch { /* ignore fallback failure */ }
    }
    return null;
  };

  const onPrintBill = async () => {
    if (!cartReadyToCommit(lines)) return;
    try {
      await flushCurrentOrder();
      const saved = (await api.get(`/pos/tabs/${selectedTableId!}`)).data as any;
      if (!saved?.id) { toast.error('No open order on this table'); return; }
      try {
        await printBill.mutateAsync({ invoiceId: saved.id });
      } catch { /* non-fatal — print failure shouldn't block preview */ }
      setShowBillPreview(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to save order');
    }
  };

  /* Print only items added since the last bill print. */
  const onPrintAdditionalBill = async () => {
    if (!cartReadyToCommit(lines)) return;
    const openOrder = await resolveOpenOrder();
    if (!openOrder) { toast.error('No open order on this table'); return; }
    if (openOrder.billPrintCount === 0) {
      toast.error('Print the initial bill first before printing an additional bill.');
      return;
    }
    try {
      await flushCurrentOrder();
      const refreshed = (await api.get(`/pos/tabs/${selectedTableId!}`)).data as any;
      const serverLines = (refreshed?.lines ?? []) as any[];
      const matched = serverLines
        .map((line: any) => ({
          ...line,
          quantity: Math.max(0, Number(line.quantity) - Number(line.billPrintedQty ?? 0)),
        }))
        .filter((line: any) => line.quantity > 0.000001)
        .map(serverLineToCart);
      if (matched.length === 0) {
        toast.info('No new items to bill since the last print.');
        return;
      }
      const additionalSubtotal = matched.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0);
      const docSubtotal = Number(refreshed?.subtotal ?? 0);
      const previousSubtotal = Math.max(0, docSubtotal - additionalSubtotal);
      const grandTotal = Number(refreshed?.totalAmount ?? 0);
      setAdditionalBillLines(matched);
      setAdditionalBillCopy(openOrder.billPrintCount + 1);
      setAdditionalBillPreviousSubtotal(previousSubtotal);
      setAdditionalBillGrandTotal(grandTotal);
      setShowAdditionalBillPreview(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to prepare additional bill');
    }
  };

  /* ============== Split Bill ============== */
  /* Dine-in: open the split workspace (divide the tab into independent bills).
   * Flush the cart first so server DocumentLine ids match the on-screen order —
   * the split references those ids. Walk-in sales fall back to multi-tender. */
  const onSplit = async () => {
    if (!tableId) {
      toast.info('Split bill is for dine-in tables. For counter sales, add multiple tenders at payment.');
      setShowPayment(true);
      return;
    }
    if (!cartReadyToCommit(lines)) return;
    try {
      const st = (await api.get(`/pos/tabs/${tableId}/split`)).data as any;
      if (st?.splitActive) {
        if (orderSig(useCartStore.getState().lines) !== tabSyncSig.current) throw new Error('Unsaved changes must be resolved before reopening the split.');
      } else {
        await flushCurrentOrder();
      }
      setShowSplit(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || e?.message || 'Could not save the latest order before splitting. Your cart is preserved.');
    }
  };

  /* ============== Fullscreen toggle ============== */
  const onToggleFullscreen = () => {
    const next = !fullscreen;
    setFullscreen(next);
    document.body.classList.toggle('pos-terminal-fullscreen', next);
    try {
      if (next) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    } catch { /* noop */ }
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

  /* Log off the POS session only — drops the POS PIN user (shift stays open,
   * app login untouched) and returns to the terminal PIN login screen where
   * another waiter can sign in. */
  const logoffPosSession = () => {
    setLastCompleted(null);
    usePosAuthStore.getState().logout();
    setShowPosLogin(true);
    refetchSession();
  };

  const handleUserChanged = () => {
    // Force re-render — locked state recalculates via posUser
    setShowPosLogin(!usePosAuthStore.getState().user);
    refetchSession();
  };

  return (
    <div className={'pos-shell-pro' + (fullscreen ? ' dark-mode' : '')}>
      <PendingSaleRecovery />
      {/* POS PIN Login screen — shown until a cashier authenticates */}
      {showPosLogin && !posUser ? (
        <PosLoginScreen
          onLoggedIn={() => { setShowPosLogin(false); refetchSession(); }}
          onBeforeSubmit={enterFullscreen}
          onExit={() => {
            setFullscreen(false);
            document.body.classList.remove('pos-terminal-fullscreen');
            document.exitFullscreen?.().catch(() => {});
            navigate('/');
          }}
        />
      ) : null}

      <Topbar
        search={search}
        onSearch={setSearch}
        onOpenShift={() => setShowOpenShift(true)}
        onCloseShift={() => setShowCloseShift(true)}
        onOpenTableSelector={() => setShowTableSelector(true)}
        activeTableLabel={selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : null}
        staffName={user?.firstName}
        staffRole={(user as any)?.roles?.[0]}
        user={user}
        session={session ?? null}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onLogout={logout}
        onUserChanged={handleUserChanged}
        onOpenOrders={() => setShowOrders(true)}
        ordersCount={ordersCount}
        // A-004: the offline queue indicator (health probe + auto-replay +
        // failed-sale review) MUST be mounted — without it, sales parked in
        // the offline queue are invisible until shift close blocks.
        rightExtras={(
          <>
            <PosLogoffButton onLoggedOff={() => { setShowPosLogin(true); refetchSession(); }} />
            <OfflineIndicator />
          </>
        )}
        orderType={orderTypeFromStore ?? 'dine-in'}
      />

      <div className={tableView === 'grid' && !selectedTableId ? 'pos-body-pro pos-body-pro--tables' : 'pos-body-pro'}>
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
        ) : showOrders ? (
          /* Odoo-style Orders panel (full-page, all order types) */
          <div className="pos-menus-pro">
            <OrdersListPanel
              open={showOrders}
              activeOrderId={orderId ?? undefined}
              onOpenOrder={openOrder}
              onNewOrder={newTablelessOrder}
              onClose={() => setShowOrders(false)}
            />
          </div>
        ) : (orderTypeFromStore === 'dine-in' || !orderTypeFromStore) && !selectedTableId && tableView !== 'ordering' ? (
          /* Dine-in table grid (full-page, no cart) */
          <div className="pos-menus-pro">
            <div className="flex flex-col h-full">
              {/* Minimal header */}
              <div className="flex items-end justify-between px-6 pt-5 pb-2">
                <div>
                  <h2 className="text-base font-bold text-slate-700">Tables</h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {tables.length} tables · {tables.filter(t => t.status === 'occupied').length} occupied
                  </p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-6 pb-6">
                {tablesLoading ? (
                  <div className="text-center text-slate-400 py-12">Loading tables...</div>
                ) : tables.length === 0 ? (
                  <div className="text-center text-slate-400 py-12">
                    <LayoutGrid className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p className="font-semibold">No tables configured</p>
                    <p className="text-xs mt-1">Create tables in the Tables admin page first.</p>
                  </div>
                ) : zones.filter((z) => z.active).length === 0 ? (
                  <div className="text-center text-slate-400 py-12">
                    <LayoutGrid className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p className="font-semibold">No active zones</p>
                    <p className="text-xs mt-1">All zones are Inactive — activate one in Table Zones management.</p>
                  </div>
                ) : (() => {
                  // Only active zones surface in the selling terminal — an
                  // Inactive zone hides its tables from the floor map (the
                  // tables keep their assignment and stay visible in admin).
                  const activeZoneKeys = new Set(
                    zones.filter((z) => z.active).map((z) => z.key),
                  );
                  const grouped = new Map<string, PosTable[]>();
                  for (const t of tables) {
                    if (!activeZoneKeys.has(t.zone)) continue;
                    const key = t.zone;
                    const arr = grouped.get(key) ?? [];
                    arr.push(t);
                    grouped.set(key, arr);
                  }
                  // Zone groups follow the user's View Order preference
                  // (zone.sortOrder), tie-broken exactly like the Manage Zones
                  // list; unknown zone keys sort last.
                  const rank = zoneRankMap(zones);
                  return Array.from(grouped.entries()).sort((a, b) =>
                    compareZoneKeys(rank, a[0], b[0]),
                  );
                })().map(([zoneKey, list]) => {
                  const zMeta = zones.find((z) => z.key === zoneKey);
                  return (
                  <div key={zoneKey} className="mb-6 last:mb-0">
                    <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400 mb-3">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ background: zMeta?.color ?? '#cbd5e1' }}
                      />
                      {zoneLabelOf(zones, zoneKey)} · {list.length} table{list.length === 1 ? '' : 's'}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                      {list.map((t) => {
                        const openOrders = (t.orders ?? []).filter((o) => !o.closedAt);
                        const backendTotal = openOrders.reduce((s, o) => s + Number(o.order?.totalAmount ?? 0), 0);
                        const hasLocal = tableHasLocalCart(t.id);
                        const local = localCartTotal(t.id);
                        const combinedTotal = backendTotal + local;
                        const combinedCount = openOrders.length + (hasLocal ? 1 : 0);
                        const meta = statusMeta(t.status);
                        const statusLabel = t.status === 'occupied' ? 'Occupied' : t.status === 'out_of_service' ? 'Out of service' : t.status === 'reserved' ? 'Reserved' : 'Available';
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => handleTableClick(t)}
                            className={`relative rounded-xl border px-3 py-2.5 text-left transition-all duration-200
                              flex flex-col
                              hover:shadow-lg hover:-translate-y-0.5
                              ${meta.card}
                            `}
                          >
                            {/* Occupied top indicator */}
                            {t.status === 'occupied' && (
                              <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl bg-orange-500" />
                            )}

                            {/* Draft badge */}
                            {hasLocal && (
                              <div className="absolute top-2 right-2 z-10">
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                  Draft
                                </span>
                              </div>
                            )}

                            <div className="text-lg font-bold text-slate-800 leading-tight truncate pr-12">
                              {t.name}
                            </div>

                            {/* Table number below name */}
                            <div className="text-xs font-medium text-slate-400">
                              T{t.number} · {t.seats} seats
                            </div>

                            {/* Who is serving this table. Distinct names, because
                                a table can hold more than one open order and they
                                need not belong to the same waiter. */}
                            {/* Server(s) + status on one line (zone is the group header) */}
                            <div className="mt-1.5 flex items-center gap-2 min-h-[18px]">
                              {(() => {
                                const servers = Array.from(new Set(
                                  openOrders.map((o) => o.waiterName).filter(Boolean) as string[],
                                ));
                                if (!servers.length) return null;
                                return (
                                  <div className="flex min-w-0 items-center gap-1 text-[11px] font-semibold text-indigo-600">
                                    <User className="w-3 h-3 shrink-0" />
                                    <span className="truncate">{servers.join(', ')}</span>
                                  </div>
                                );
                              })()}
                              <span className={`ml-auto shrink-0 text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${meta.pill}`}>
                                {statusLabel}
                              </span>
                            </div>

                            {/* Order footer */}
                            {combinedCount > 0 ? (
                              <div className="mt-2 pt-1.5 border-t border-slate-100 flex items-center justify-between">
                                <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                                  <Clock className="w-3 h-3" />
                                  {minutesBetween(openOrders[0]?.openedAt ?? new Date(), null)}m
                                </span>
                                <span className="text-[11px] font-bold text-slate-700">{fmtMoney(combinedTotal)}</span>
                              </div>
                            ) : (
                              <div className="mt-2 pt-1.5 border-t border-slate-100 text-[11px] text-slate-400 font-medium">
                                Tap to open
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (orderTypeFromStore === 'dine-in' || !orderTypeFromStore) && selectedTableId && tableView === 'detail' && selectedTable ? (
          /* Dine-in table detail view (left) + OrderPanel (right) */
          <div className="pos-menus-pro">
            <TableDetailView
              table={selectedTable}
              onBack={handleGoBackToGrid}
              onStartOrder={handleNewOrder}
              onContinueDraft={handleContinueDraft}
              hasLocalCart={tableHasLocalCart(selectedTable.id)}
            />
          </div>
        ) : (
          /* Menu (left) + OrderPanel (right) — ordering, takeaway, delivery */
          <>
            <div className="pos-menus-pro">
              <CategoryStrip
                categories={categories as any}
                activeId={activeCategory}
                onSelect={setActiveCategory}
              />
              <div className="relative flex-1 flex flex-col min-h-0">
                <MenuGrid products={gridItems as any} locked={locked} onPick={onPickProduct} />
              </div>
            </div>
          </>
        )}

        {/* OrderPanel — hidden in full-page tables grid + Orders panel modes */}
        {!locked && tableView !== 'grid' && !showOrders && (
          <OrderPanel
            customerName={customer?.name}
            orderTypeLabel={orderTypeLabel}
            orderType={orderTypeFromStore ?? 'dine-in'}
            onChangeOrderType={handleChangeOrderType}
            tableLabel={selectedTable ? `T${selectedTable.number}${selectedTable.name ? ` ${selectedTable.name}` : ''}` : undefined}
            tableId={tableId}
            billAlreadyPrinted={!!selectedTable?.orders?.find((o) => !o.closedAt && (o.order?.billPrintCount ?? 0) > 0)}
            onPrintAdditionalBill={onPrintAdditionalBill}
            onInc={onInc}
            onDec={onDec}
            onRemove={canDeleteItem ? onRemove : undefined}
            canDiscount={canDiscount}
            onNote={onLineNote}
            onLineDiscount={onLineDiscount}
            onPrintBill={onPrintBill}
            quotedTotal={saleQuote.data?.total}
            canOverridePrice={false}
            onCharge={onCharge}
            onSplit={onSplit}
            onAddCustomer={() => setShowCustomer(true)}
            onAddDiscount={() => setShowDiscount(true)}
            onPrintKot={async () => {
              if (!cartReadyToCommit(lines)) return;
              if (!tableId) { toast.error('Select a table before printing a KOT'); return; }
              try {
                // Match Bill: save first, then preview only the quantities not yet
                // on a paper KOT (kotPrintedQty). This is NOT kitchenPrintedQty —
                // auto-send stamps that on every save when an item has a KDS
                // station, which made the very first KOT read "nothing new".
                await flushCurrentOrder();
                const saved = await api.get(`/pos/tabs/${tableId}`).then((r: any) => r.data);
                const unprinted = ((saved?.lines ?? []) as any[])
                  .filter((line: any) => !!line.productId || !!line.menuItemId || !!line.comboId)
                  .map((line: any) => ({
                    ...line,
                    quantity: Math.max(0, Number(line.quantity) - Number(line.kotPrintedQty ?? 0)),
                  }))
                  .filter((line: any) => line.quantity > 0.000001)
                  .map(serverLineToCart);
                if (unprinted.length === 0) { toast.info('No new items to print on the KOT'); return; }
                if (!saved?.id) { toast.error('No open order on this table'); return; }
                // Like the Bill: pressing KOT prints and claims immediately, so
                // closing the preview can never leave these items "unprinted"
                // and repeat them on the next KOT. The server decides the delta
                // under the order lock; the preview just shows what went out.
                const result: any = await printKot.mutateAsync({ invoiceId: saved.id });
                if (result?.printedCount === 0) { toast.info('No new items to print on the KOT'); return; }
                if (result?.ok === false && result?.message) toast.error(`KOT printer: ${result.message}`);
                // Put anything not yet on the KDS board there too; its own paper
                // step finds nothing left to print.
                try { await fireKitchen.mutateAsync({ tableId }); } catch { /* the KDS never blocks a KOT */ }
                setKotLines(unprinted);
                setKotCopy(Number(result?.kotNumber ?? (Number(saved?.kotPrintCount ?? 0) + 1)) || 1);
                setShowKotPreview(true);
              } catch (e: any) {
                toast.error(e?.response?.data?.message || e?.message || 'Failed to prepare KOT');
              }
            }}
            onVoidItem={canVoidItem ? (line) => setVoidLine(line) : undefined}
            onMoveItems={() => setShowMoveItems(true)}
            onSettleTab={tableId ? handleSettleTab : undefined}
          />
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
        key={'discount-' + showDiscount}
        open={showDiscount}
        initialPercent={transactionDiscountPercent}
        thresholdPercent={discountTier1}
        thresholdAmount={discountTier1Amount}
        subtotal={cartSubtotal}
        onClose={() => setShowDiscount(false)}
        onApply={onApplyOrderDiscount}
        onApplyEx={onApplyOrderDiscountEx}
      />
      {lineForDiscount ? (
        <LineDiscountDialog
          open={!!lineForDiscount}
          line={lineForDiscount}
          thresholdPercent={discountTier1}
          onClose={() => setLineForDiscount(null)}
          onApply={onLineDiscountApply}
        />
      ) : null}
      <DiscountReasonDialog
        open={showDiscountReason}
        onClose={() => settleDiscountReason(null)}
        onSelect={(reason) => {
          useCartStore.setState({ transactionDiscountReason: reason });
          settleDiscountReason(reason);
        }}
      />
      <PaymentDialog
        open={showPayment}
        total={total}
        effectiveDiscountPercent={Math.max(transactionDiscountPercent, ...lines.map((l) => l.discountPercent))}
        storeCreditBalance={storeCredit?.balance ?? 0}
        onRequestOverride={requestOverride}
        onClose={() => { setShowPayment(false); setIsTabSettle(false); }}
        onSettle={onSettle}
        creditEnabled={!!customer?.id}
        onCreditSale={onCreditSale}
        customerName={customer?.name}
        creditInfo={creditInfo ?? null}
        onPickCustomer={() => setShowCustomer(true)}
      />
      <OverrideDialog
        open={!!overrideKind}
        kind={overrideKind ?? 'discount'}
        onClose={() => onOverrideVerified(null)}
        onVerified={onOverrideVerified}
      />
      <PinConfirmDialog
        open={showPinConfirm}
        title="Delete item"
        description={pendingRemoveLine
          ? `Give a reason and your PIN to take "${pendingRemoveLine.name}" off this order.`
          : 'Give a reason and your PIN to take this item off the order.'}
        reasonLabel="Reason for deleting"
        onClose={() => { setShowPinConfirm(false); setPendingRemoveLine(null); }}
        onVerified={onPinVerified}
      />

      {/* Void item dialog */}
      <VoidItemDialog
        open={!!voidLine}
        line={voidLine}
        sentToKitchen={Number(voidLine?.kitchenPrintedQty ?? 0) > 0}
        onClose={() => setVoidLine(null)}
        onConfirm={(lineId, reason) => voidLineOnServer(lineId, reason)}
      />

      {/* Move Items — 2-step wizard */}
      {tableId ? (
        <MoveItemsDialog
          open={showMoveItems}
          onClose={() => setShowMoveItems(false)}
          tableId={tableId}
          lines={lines}
          onConfirm={doMoveItems}
          busy={transferBusy}
        />
      ) : null}

      {/* Split bill — divide the tab into independently-payable bills */}
      <SplitBillDialog
        open={showSplit}
        tableId={tableId ?? null}
        tableLabel={activeTableLabel ?? undefined}
        cashSessionId={session?.id}
        onClose={() => setShowSplit(false)}
        onTableClosed={() => {
          setShowSplit(false);
          tabSyncSig.current = '';
          clearCart();
          setCustomer(null);
          setSelectedTableId(null);
          setTableView('grid');
          refetchSession();
          currentSentLineIds.current.clear();
        }}
      />

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
        onPrint={async () => {
          const docId = selectedTable?.orders?.find((o) => !o.closedAt)?.orderId;
          if (docId) {
            try { await printBill.mutateAsync({ invoiceId: docId }); } catch { /* non-fatal */ }
          }
        }}
      />

      <ReceiptPreview
        open={showKotPreview}
        onClose={() => setShowKotPreview(false)}
        type="kot"
        title={kotCopy > 1 ? `Additional KOT #${kotCopy}` : 'Kitchen Order Ticket'}
        subtitle={kotCopy > 1 ? 'ADDITIONAL KOT — NEW ITEMS ONLY' : 'KITCHEN ORDER TICKET'}
        lines={cartToReceiptLines(kotLines)}
        total={kotLines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0)}
        orderTypeLabel={orderTypeLabel ?? undefined}
        tableLabel={activeTableLabel ?? undefined}
        customerName={customer?.name}
      />

      <ReceiptPreview
        open={showAdditionalBillPreview}
        onClose={() => setShowAdditionalBillPreview(false)}
        type="bill"
        title={`Additional Bill #${additionalBillCopy}`}
        subtitle="ADDITIONAL BILL"
        lines={cartToReceiptLines(additionalBillLines)}
        total={additionalBillLines.reduce((s, l) => s + l.unitPrice * l.quantity * (1 - l.discountPercent / 100), 0)}
        orderTypeLabel={orderTypeLabel ?? undefined}
        tableLabel={activeTableLabel ?? undefined}
        customerName={customer?.name}
        previousSubtotal={additionalBillPreviousSubtotal}
        grandTotal={additionalBillGrandTotal}
        onPrint={async () => {
          const docId = selectedTable?.orders?.find((o) => !o.closedAt)?.orderId;
          if (docId) {
            try { await printAdditionalBill.mutateAsync({ invoiceId: docId }); } catch { /* non-fatal */ }
          }
        }}
      />

      {/* After settle: pop the settlement receipt so the cashier can print it.
          Server-rendered PDF when we have an invoiceId; the client snapshot is a
          fallback only for offline-queued sales (no invoiceId yet). */}
      {lastCompleted?.invoiceId ? (
        <ReceiptPreviewDialog
          open
          invoiceId={lastCompleted.invoiceId}
          invoiceNumber={lastCompleted.invoiceNumber}
          receiptHtml={lastCompleted.receiptHtml}
          canReprint={false}
          onVoid={(id, num) => {
            setLastCompleted(null);
            setCancelInvoice({ id, number: num });
            setShowCancelOrder(true);
          }}
          onClose={() => setLastCompleted(null)}
          onLogoff={logoffPosSession}
        />
      ) : lastCompleted ? (
        <ReceiptPreview
          open
          onClose={() => setLastCompleted(null)}
          type="bill"
          title={`Receipt ${lastCompleted.invoiceNumber ?? ''}`}
          subtitle="Offline — sync pending"
          lines={lastCompleted.lines}
          total={lastCompleted.total}
          discountPercent={lastCompleted.discountPercent}
          discountAmount={lastCompleted.discountAmount}
          orderTypeLabel={lastCompleted.orderTypeLabel}
          tableLabel={lastCompleted.tableLabel}
          customerName={lastCompleted.customerName}
        />
      ) : null}
      {canReprint && (
        <>
          {lastCompleted?.invoiceId && (
            <button
              type="button"
              className="fixed bottom-4 right-4 z-50 bg-sky-700 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-semibold hover:bg-sky-800"
              onClick={() => setShowReprint({ invoiceId: lastCompleted.invoiceId!, title: 'Receipt' })}
            >
              <Printer className="inline h-4 w-4 mr-1" /> Reprint
            </button>
          )}
          <ReprintDialog
            open={!!showReprint}
            title={showReprint?.title ?? ''}
            onClose={() => setShowReprint(null)}
            onConfirm={(reason) => {
              if (!showReprint) return;
              reprintReceipt.mutateAsync({ invoiceId: showReprint.invoiceId, reason });
              toast.success(`Reprint queued: ${reason}`);
            }}
          />
        </>
      )}

      {/* P4 4-layer order flow dialogs */}
      <VariantPicker
        open={nextStep === 'variant'}
        productName={pendingItem?.productName ?? ''}
        variants={pendingBundle?.variants ?? []}
        onClose={cancelOrderFlow}
        onConfirm={onVariantConfirm}
      />
      <AccompanimentPicker
        open={nextStep === 'accompaniment'}
        productName={pendingItem?.productName ?? ''}
        groups={pendingBundle?.accompanimentGroups ?? []}
        onClose={cancelOrderFlow}
        onBack={() => setPendingItem((prev) => prev ? { ...prev, variantId: undefined, variantName: undefined, variantPrice: undefined } : prev)}
        onConfirm={onAccompanimentConfirm}
      />
      <AddOnsDialog
        open={nextStep === 'addons'}
        productId={pendingItem?.productId ?? null}
        basePrice={effectiveBasePrice > 0 ? effectiveBasePrice : undefined}
        onClose={cancelOrderFlow}
        onBack={() => setPendingItem((prev) => prev ? { ...prev, accompanimentOptionIds: undefined, accompanimentNames: undefined, accompanimentPriceImpact: undefined } : prev)}
        onAdd={onAddAddOnsConfirm}
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
  const tableTotal = openOrders.reduce((s, o) => s + Number(o.order?.totalAmount ?? 0), 0);

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
            <span className="text-lg font-bold text-slate-800">
              Table {table.number}{table.name ? ` — ${table.name}` : ''}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}`}>
              {badge.label}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {table.seats} seats · Zone: {table.zoneName ?? table.zone} · {openOrders.length} open order{openOrders.length !== 1 ? 's' : ''}
            {tableTotal > 0 && <span className="ml-2 font-semibold text-slate-700">· Total {fmt(tableTotal)}</span>}
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
                      {o.order?.orderNumber ?? `#${o.id.slice(0, 6)}`}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-400">
                      {o.openedAt ? `${Math.max(1, Math.floor((Date.now() - new Date(o.openedAt).getTime()) / 60000))}m ago` : 'New'}
                    </span>
                  </div>
                  {o.waiterName && (
                    <div className="flex items-center gap-1 text-xs font-semibold text-indigo-600 truncate">
                      <User className="w-3 h-3 shrink-0" /> {o.waiterName}
                    </div>
                  )}
                  {o.customerName && (
                    <div className="text-xs text-slate-600 font-medium truncate">{o.customerName}</div>
                  )}
                  {o.notes && (
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">Note: {o.notes}</div>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold text-slate-800">
                    {o.order ? fmt(Number(o.order.totalAmount || 0)) : '—'}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {o.order?.status ?? 'open'} · {o.guestCount ?? '?'} guests
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

/** POS mode router — renders CafeTerminal, RetailTerminal or RentalTerminal based on org config. */
function TerminalPageRouter() {
  const { data: settings } = usePosSettings();
  const posMode = (settings as any)?.posMode ?? 'cafe';
  if (posMode === 'retail') return <RetailTerminal />;
  if (posMode === 'rental') return <RentalTerminal />;
  return <TerminalPage />;
}

export default TerminalPageRouter;
