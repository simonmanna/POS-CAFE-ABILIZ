import type { PosTableStatus } from './types';

/** Tailwind-style colour palette mirroring the original POS picker. */
export const STATUS_META: Record<
  PosTableStatus,
  { label: string; bg: string; border: string; dot: string; text: string; pill: string }
> = {
  available: {
    label: 'Available',
    bg: 'bg-emerald-50',
    border: 'border-emerald-300',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700',
    pill: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  },
  occupied: {
    label: 'Occupied',
    bg: 'bg-orange-50',
    border: 'border-orange-300',
    dot: 'bg-orange-500',
    text: 'text-orange-700',
    pill: 'bg-orange-100 text-orange-700 border-orange-200',
  },
  reserved: {
    label: 'Reserved',
    bg: 'bg-blue-50',
    border: 'border-blue-300',
    dot: 'bg-blue-500',
    text: 'text-blue-700',
    pill: 'bg-blue-100 text-blue-700 border-blue-200',
  },
  out_of_service: {
    label: 'Out of Service',
    bg: 'bg-slate-100',
    border: 'border-slate-300',
    dot: 'bg-slate-400',
    text: 'text-slate-600',
    pill: 'bg-slate-200 text-slate-700 border-slate-300',
  },
  cleaning: {
    label: 'Cleaning',
    bg: 'bg-cyan-50',
    border: 'border-cyan-300',
    dot: 'bg-cyan-500',
    text: 'text-cyan-700',
    pill: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  },
};

export const ZONE_LABEL: Record<string, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
  terrace: 'Terrace',
  vip: 'VIP',
  garden: 'Garden',
  bar: 'Bar',
  custom: 'Custom',
};

export const SHAPE_LABEL: Record<string, string> = {
  square: 'Square',
  rectangle: 'Rectangle',
  circle: 'Circle',
};

export const RESERVATION_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  seated: 'Seated',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export const RESERVATION_STATUS_COLOR: Record<string, string> = {
  pending: 'bg-blue-100 text-blue-700 border-blue-200',
  seated: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  completed: 'bg-slate-100 text-slate-600 border-slate-200',
  cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
  no_show: 'bg-orange-100 text-orange-700 border-orange-200',
};

export function fmtMoney(amount: number | string | null | undefined, currency = 'UGX') {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return `${currency} 0`;
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function minutesBetween(from: string | Date, to: string | Date | null): number {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 60000);
}