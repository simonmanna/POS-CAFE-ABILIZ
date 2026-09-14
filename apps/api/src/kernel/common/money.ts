import { Prisma } from '@prisma/client';

/**
 * Money math uses Prisma.Decimal (decimal.js) — never JS floats (ADR-009).
 * Ledger amounts are stored as Decimal(20,6); display rounding is per-currency.
 */
export type Money = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

export function dec(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(v), new Prisma.Decimal(0));
}

export function round(value: Prisma.Decimal, decimalPlaces = 2): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

export function isZero(value: Prisma.Decimal): boolean {
  return value.isZero();
}

export function eq(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  return a.equals(b);
}

/** True when |a - b| <= epsilon (default 0.0001) — for balance checks after rounding. */
export function approxEqual(a: Prisma.Decimal, b: Prisma.Decimal, epsilon = 0.0001): boolean {
  return a.minus(b).abs().lessThanOrEqualTo(epsilon);
}

/**
 * Multiply quantities exactly (Decimal) and round to the ledger's 6-dp scale,
 * returned as a JS number for DTO boundaries. Multiplying raw JS numbers drifts
 * (0.1 × 3 = 0.30000000000000004, 0.018 × 7 = 0.12599999999999999) and the
 * error accumulates across recipe lines and high-volume sales.
 */
export function qtyMul(...factors: Prisma.Decimal.Value[]): number {
  return Number(
    factors.reduce<Prisma.Decimal>((acc, f) => acc.times(new Prisma.Decimal(f ?? 0)), new Prisma.Decimal(1)).toDecimalPlaces(6),
  );
}
