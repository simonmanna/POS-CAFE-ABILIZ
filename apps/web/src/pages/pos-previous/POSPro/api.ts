// Centralised API client for the POS Pro page.
import api from '../../../services/api';
import type { Category, Menu, Order, Table, Customer, PaymentTender } from './types';

export const posApi = {
  // categories + menus
  listCategories: () => api.get<Category[]>('/categories').then((r) => r.data),
  listMenus: (active = true) => api.get<Menu[]>('/menus', { params: active ? { active: 'true' } : {} }).then((r) => r.data),

  // tables
  listTables: () => api.get<Table[]>('/tables').then((r) => r.data),
  getTableStats: () => api.get<{ total: number; available: number; occupied: number; reserved: number }>('/tables/stats').then((r) => r.data),
  setTableStatus: (id: number, status: string) => api.put(`/tables/${id}/status`, { status }).then((r) => r.data),
  mergeTables: (sourceId: number, targetId: number) => api.post(`/tables/${sourceId}/merge/${targetId}`).then((r) => r.data),
  unmergeTables: (tableId: number) => api.post(`/tables/${tableId}/unmerge`).then((r) => r.data),
  transferOrders: (fromId: number, toId: number, orderIds?: number[]) =>
    api.post(`/tables/${fromId}/transfer/${toId}`, { orderIds }).then((r) => r.data),

  // customers
  listCustomers: (q?: string) => api.get<Customer[]>('/customers', { params: q ? { q } : {} }).then((r) => r.data),
  createCustomer: (body: { name: string; phone?: string; email?: string }) =>
    api.post<Customer>('/customers', body).then((r) => r.data),

  // orders
  createOrder: (body: { tableId?: number; customerId?: number; type: string }) =>
    api.post<Order>('/orders', body).then((r) => r.data),
  getOrder: (id: number) => api.get<Order>(`/orders/${id}`).then((r) => r.data),
  addItem: (orderId: number, body: { menuId: number; quantity?: number; addOns?: number[]; notes?: string }) =>
    api.post<Order>(`/orders/${orderId}/items`, body).then((r) => r.data),
  updateItemQuantity: (orderId: number, itemId: number, quantity: number) =>
    api.put<Order>(`/orders/${orderId}/items/${itemId}/quantity`, { quantity }).then((r) => r.data),
  removeItem: (orderId: number, itemId: number) =>
    api.delete<Order>(`/orders/${orderId}/items/${itemId}`).then((r) => r.data),
  voidItem: (orderId: number, itemId: number, reason: string) =>
    api.put<Order>(`/orders/${orderId}/items/${itemId}/void`, { reason }).then((r) => r.data),
  setDiscount: (orderId: number, body: { discountType: string; discountValue: number; taxRate?: number; serviceChargeRate?: number }) =>
    api.put<Order>(`/orders/${orderId}/discount`, body).then((r) => r.data),
  setTax: (orderId: number, body: { taxRate?: number; taxAmount?: number }) =>
    api.put<Order>(`/orders/${orderId}/tax`, body).then((r) => r.data),
  setServiceCharge: (orderId: number, body: { serviceChargeRate?: number; serviceChargeAmount?: number }) =>
    api.put<Order>(`/orders/${orderId}/service-charge`, body).then((r) => r.data),
  setCustomer: (orderId: number, customerId: number | null) =>
    api.put<Order>(`/orders/${orderId}/customer`, { customerId }).then((r) => r.data),
  setType: (orderId: number, type: string) =>
    api.put<Order>(`/orders/${orderId}/type`, { type }).then((r) => r.data),
  cancelOrder: (orderId: number) => api.put<Order>(`/orders/${orderId}/cancel`).then((r) => r.data),
  completeOrder: (orderId: number) => api.put<Order>(`/orders/${orderId}/complete`).then((r) => r.data),
  // hold / resume
  holdOrder: (orderId: number, body: { reason?: string }) =>
    api.post<Order>(`/orders/${orderId}/hold`, body || {}).then((r) => r.data),
  resumeOrder: (orderId: number) =>
    api.post<Order>(`/orders/${orderId}/resume`, {}).then((r) => r.data),
  listHeldOrders: () => api.get<Order[]>('/orders', { params: { status: 'HELD' } }).then((r) => r.data),

  // counter / quick order
  createCounterOrder: (body: { customerId?: number; notes?: string; type?: string }) =>
    api.post<Order>('/orders/counter', body || {}).then((r) => r.data),

  // per-line discount
  applyLineDiscount: (
    orderId: number,
    itemId: number,
    body: { discountType: 'percentage' | 'fixed'; discountValue: number; discountReason: string; managerPin?: string },
  ) => api.put<Order>(`/orders/${orderId}/items/${itemId}/discount`, body).then((r) => r.data),
  clearLineDiscount: (orderId: number, itemId: number) =>
    api.delete<Order>(`/orders/${orderId}/items/${itemId}/discount`).then((r) => r.data),

  // order-level discount with reason
  applyDiscountWithReason: (
    orderId: number,
    body: { discountType: 'percentage' | 'fixed'; discountValue: number; reason: string; managerPin?: string },
  ) => api.put<Order>(`/orders/${orderId}/discount-with-reason`, body).then((r) => r.data),
  getBill: (orderId: number) => api.get(`/orders/${orderId}/bill`).then((r) => r.data),

  // payments
  settle: (orderId: number, body: { payments: PaymentTender[] }) =>
    api.post(`/payments/settle/${orderId}`, body).then((r) => r.data),
  splitBill: (orderId: number, body: { splits: { items: { orderItemId: number; quantity: number }[] }[] }) =>
    api.post(`/payments/split-bill/${orderId}`, body).then((r) => r.data),
  refund: (body: { saleId: number; reason: string; managerPin: string; refundMethod: string; lines: { menuId: number; quantity: number }[] }) =>
    api.post('/returns', body).then((r) => r.data),

  // printing
  printKOT: (orderId: number, station?: 'BAR' | 'KITCHEN' | 'CAFE') =>
    api.post(`/print/kot/${orderId}`, { station }).then((r) => r.data),
  printReceipt: (orderId: number) => api.post(`/print/receipt/${orderId}`, {}).then((r) => r.data),
  setItemKitchenStatus: (itemId: number, status: 'NEW' | 'PREPARING' | 'READY' | 'SERVED') =>
    api.post(`/print/item/${itemId}/status`, { status }).then((r) => r.data),
};
