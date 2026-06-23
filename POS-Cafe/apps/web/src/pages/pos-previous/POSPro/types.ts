// Shared types for the POS Pro selling interface.

export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
export type OrderStatus = 'OPEN' | 'PAID' | 'CANCELLED' | 'COMPLETED';
export type KitchenStatus = 'NEW' | 'PREPARING' | 'READY' | 'SERVED';
export type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'RESERVED';
export type Station = 'BAR' | 'KITCHEN' | 'CAFE';

export interface Category {
  id: number;
  name: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
  active?: boolean;
}

export interface AddOn {
  id: number;
  name: string;
  price: number;
  menuId?: number;
}

export interface Menu {
  id: number;
  name: string;
  price: number;
  description?: string;
  image?: string;
  imageUrl?: string;
  station: Station;
  active: boolean;
  categoryId: number;
  category?: Category;
  addOns?: AddOn[];
}

export interface OrderItem {
  id: number;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  addOns?: string; // JSON string of AddOn[]
  addOnsTotal?: number;
  notes?: string;
  voided: boolean;
  voidReason?: string;
  kotPrinted: boolean;
  kitchenStatus: KitchenStatus;
  // Per-line discount
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number;
  discountAmount?: number;
  discountReason?: string;
  menuId: number;
  menu?: Menu;
  orderId: number;
}

export interface Order {
  id: number;
  orderNumber: string;
  type: OrderType;
  status: OrderStatus;
  subtotal: number;
  discountType?: string;
  discountValue?: number;
  discountAmount: number;
  taxAmount: number;
  serviceChargeAmount: number;
  tax?: number;
  total: number;
  notes?: string;
  tableId?: number;
  table?: Table;
  customerId?: number;
  customer?: Customer;
  userId: number;
  items: OrderItem[];
  payments?: Payment[];
  kotPrintedAt?: string;
  receiptPrintedAt?: string;
  // Hold / resume
  heldAt?: string;
  heldBy?: number;
  holdReason?: string;
  resumedAt?: string;
  heldByUser?: { id: number; name: string; role?: string };
  // Origin
  source?: 'TABLE' | 'COUNTER' | 'KIOSK' | 'DELIVERY' | 'ONLINE';
  // Discount audit
  discountReason?: string;
  discountApprovedBy?: number;
  discountApprovedAt?: string;
  discountApprovals?: any[];
  // Shift / audit extras
  shiftId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Table {
  id: number;
  number: number;
  capacity: number;
  status: TableStatus;
  zone?: string;
  mergedInto?: number;
  orders?: Order[];
  parentTable?: Table;
  mergedTables?: Table[];
}

export interface Customer {
  id: number;
  name: string;
  phone?: string;
  email?: string;
}

export interface Payment {
  id: number;
  method: string;
  amount: number;
  tendered: number;
  change: number;
  reference?: string;
  createdAt: string;
}

export interface PaymentTender {
  method: 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | 'TAB';
  amount: number;
  tendered: number;
  reference?: string;
}
