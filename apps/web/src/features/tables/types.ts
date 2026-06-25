/**
 * POS Tables Management (ADR-012) — shared client types.
 * Mirrors the API shapes in `apps/api/src/modules/pos/pos-tables*.ts`.
 */

export type PosTableStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'out_of_service';

export type PosTableShape = 'square' | 'rectangle' | 'circle';

export type PosTableZone =
  | 'indoor'
  | 'outdoor'
  | 'terrace'
  | 'vip'
  | 'garden'
  | 'bar'
  | 'custom';

export type PosReservationStatus =
  | 'pending'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface PosTableOrder {
  id: string;
  tableId: string;
  documentId: string;
  customerName: string | null;
  guestCount: number | null;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  document?: {
    id: string;
    documentNumber: string;
    totalAmount: string;
    status: string;
    createdAt: string;
  };
}

export interface PosTableReservationFE {
  id: string;
  tableId: string;
  customerName: string;
  phone: string | null;
  email: string | null;
  partySize: number;
  startAt: string;
  endAt: string;
  status: PosReservationStatus;
  notes: string | null;
  seatedAt: string | null;
  noShowAt: string | null;
  cancelledAt: string | null;
  seatedDocumentId: string | null;
  table?: {
    id: string;
    number: number;
    name: string;
    status: PosTableStatus;
  };
}

export interface PosTable {
  id: string;
  organizationId: string;
  name: string;
  number: number;
  seats: number;
  zone: PosTableZone;
  customZone: string | null;
  shape: PosTableShape;
  posX: number;
  posY: number;
  width: number;
  height: number;
  status: PosTableStatus;
  notes: string | null;
  active: boolean;
  assignedWaiterId: string | null;
  mergedIntoId: string | null;
  mergedAt: string | null;
  mergedById: string | null;
  createdAt: string;
  updatedAt: string;
  orders?: PosTableOrder[];
  reservations?: PosTableReservationFE[];
  mergedInto?: { id: string; number: number; name: string } | null;
}

export interface PosTableStats {
  total: number;
  available: number;
  occupied: number;
  reserved: number;
  out_of_service: number;
  occupancyPct: number;
}

export interface CreateTableInput {
  name: string;
  number: number;
  seats?: number;
  zone?: PosTableZone;
  customZone?: string;
  shape?: PosTableShape;
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
  notes?: string;
  active?: boolean;
  assignedWaiterId?: string;
}

export interface UpdateTableInput extends Partial<CreateTableInput> {}

export interface CreateReservationInput {
  tableId: string;
  customerName: string;
  phone?: string;
  email?: string;
  partySize?: number;
  startAt: string;
  endAt: string;
  notes?: string;
}

export interface UpdateReservationInput {
  customerName?: string;
  phone?: string;
  email?: string;
  partySize?: number;
  startAt?: string;
  endAt?: string;
  notes?: string;
}

export interface SplitBillInput {
  sourceDocumentId: string;
  splits: Array<{
    label: string;
    lines: Array<{ sourceLineId: string; quantity: number }>;
  }>;
  partnerId?: string;
}

export interface UtilizationReport {
  date: string;
  totalActiveTables: number;
  hours: Array<{ hour: number; occupiedHours: number; occupancyPct: number }>;
  peakHours: number[];
}

export interface RevenueReport {
  fromDate: string;
  toDate: string;
  totals: {
    orders: number;
    revenue: string;
    averageDiningMinutes: number;
    turnoverRate: number;
  };
  perTable: Array<{
    tableId: string;
    number: number | null;
    name: string;
    zone: PosTableZone;
    customZone: string | null;
    orders: number;
    revenue: string;
  }>;
  perZone: Array<{ zone: string; orders: number; revenue: string }>;
  topPerformers: Array<{
    tableId: string;
    number: number | null;
    name: string;
    zone: PosTableZone;
    customZone: string | null;
    orders: number;
    revenue: string;
  }>;
}

export interface ReservationReport {
  fromDate: string;
  toDate: string;
  totals: {
    pending: number;
    seated: number;
    completed: number;
    cancelled: number;
    noShow: number;
    total: number;
    noShowRate: number;
    completionRate: number;
  };
  byDay: Array<{
    day: string;
    pending: number;
    seated: number;
    completed: number;
    cancelled: number;
    noShow: number;
    total: number;
  }>;
}