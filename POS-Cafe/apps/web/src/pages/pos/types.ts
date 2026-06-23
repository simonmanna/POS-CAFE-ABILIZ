/**
 * Shared types for the Cafe POS terminal.
 *
 * Maps to the @erp/shared primitives:
 *   - Product (with category)   ← menu item
 *   - Partner (isCustomer=true) ← customer
 *   - PosHold                   ← parked order
 *   - Document (sales_invoice)  ← receipt
 *   - Payment                   ← tender
 */
import type { CartLine } from '@/features/pos/types';

export interface Category {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface Product {
  id: string;
  code: string;
  sku: string | null;
  name: string;
  productType: 'stockable' | 'service' | 'consumable' | string;
  salesPrice: string | null;
  categoryId: string | null;
  category?: { id: string; name: string; color?: string | null } | null;
  isActive: boolean;
  /** P10: when true, the displayed price already includes tax. */
  taxInclusive?: boolean;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
}

export interface HeldOrder {
  id: string;
  name: string;
  status: 'open' | 'recalled' | 'cancelled';
  totalAmount: string;
  partnerId: string | null;
  branchId: string | null;
  cashSessionId: string | null;
  notes: string | null;
  createdAt: string;
  lines: HeldOrderLine[];
}

export interface HeldOrderLine {
  id: string;
  productId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxId: string | null;
  lineNumber: number;
  note: string | null;
}

export interface CashSession {
  id: string;
  cashRegisterId: string;
  userId: string | null;
  status: 'open' | 'closed';
  openingFloat: string;
  closingCounted?: string | null;
  closingExpected?: string | null;
  closingDifference?: string | null;
  openedAt: string | null;
  closedAt?: string | null;
  notes?: string | null;
  cashRegister?: { id: string; code: string; name: string };
}

export interface CashRegister {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface CashMovementItem {
  id: string;
  movementType: string;
  amount: string;
  reason: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  performedBy: string | null;
  createdAt: string;
  runningTotal: string;
}

export interface SessionDetail {
  id: string;
  cashRegister: { id: string; code: string; name: string };
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  closingCounted: string | null;
  closingExpected: string | null;
  closingDifference: string | null;
  notes: string | null;
  bankedAmount: string | null;
  bankName: string | null;
  varianceReason: string | null;
  varianceStatus: string | null;
}

export interface MovementsResponse {
  session: SessionDetail;
  movements: CashMovementItem[];
}

export interface SessionHistoryItem {
  id: string;
  cashRegister: { id: string; code: string; name: string };
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  closingCounted: string | null;
  closingExpected: string | null;
  closingDifference: string | null;
  movementCount: number;
  varianceReason: string | null;
  varianceStatus: string | null;
  notes: string | null;
}

export interface DailyReconciliationRow {
  sessionId: string;
  cashRegisterName: string;
  cashierName: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  salesTotal: string;
  payInsTotal: string;
  payOutsTotal: string;
  refundsTotal: string;
  expectedCash: string;
  actualCash: string | null;
  variance: string | null;
  varianceReason: string | null;
  bankedAmount: string | null;
}

export interface DailyReconciliationReport {
  date: string;
  sessionCount: number;
  sessions: DailyReconciliationRow[];
  totals: {
    openingFloat: string;
    salesTotal: string;
    payInsTotal: string;
    payOutsTotal: string;
    refundsTotal: string;
    bankedAmount: string;
    expectedCash: string;
  };
}

export interface CheckoutResult {
  invoiceId: string;
  invoiceNumber: string;
  paymentIds: string[];
  total: number;
  change: number;
}

export interface XReport {
  asOf: string;
  cashSession: CashSession | null;
  totals: {
    saleCount: number;
    salesTotal: string;
    refundsTotal: string;
    netSales: string;
    overridesTotal: string;
    payInsTotal: string;
    payOutsTotal: string;
    expectedCash: string;
  };
  byMethod: Array<{ method: string; count: number; total: string }>;
  byCategory: Array<{ categoryId: string | null; categoryName: string; count: number; total: string }>;
}

export interface SalesSummaryPeriod {
  periodKey: string;
  revenue: string;
  orders: number;
  avgOrderValue: string;
  discounts: string;
  taxes: string;
}

export interface SalesSummaryReport {
  fromDate: string;
  toDate: string;
  groupBy: 'day' | 'week' | 'month';
  totals: {
    revenue: string;
    orders: number;
    avgOrderValue: string;
    discounts: string;
    taxes: string;
  };
  periods: SalesSummaryPeriod[];
  byMethod: Array<{ method: string; count: number; total: string }>;
}

export { type CartLine };
export type PaymentMethod = 'cash' | 'bank' | 'card' | 'mobile_money' | 'store_credit';

export interface PaymentTender {
  method: PaymentMethod;
  amount: number;
  reference?: string;
}