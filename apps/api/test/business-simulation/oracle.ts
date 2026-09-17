/**
 * Independent oracle. L1 = what the scenario says should happen, computed here
 * with exact decimals from the fixture + policy — never from POS-computed totals.
 */
import { Prisma } from '@prisma/client';
import { BUSINESS_POLICY } from './policy';

export const D = (v: Prisma.Decimal.Value | null | undefined) => new Prisma.Decimal(v ?? 0);
export const S = (v: Prisma.Decimal.Value | null | undefined) => { const d = D(v); return d.decimalPlaces() > 2 ? d.toFixed(6) : d.toFixed(2); };

/** Half-up to the operational currency scale (whole shillings). */
export function money(v: Prisma.Decimal.Value) {
  return D(v).toDecimalPlaces(BUSINESS_POLICY.currency.operationalScale, Prisma.Decimal.ROUND_HALF_UP);
}

export interface IntendedLine { sku: string; qty: number; unitPrice: number; taxRate: number; discountPercent?: number; discountAmount?: number }

/** Inclusive-price tax per line, rounded once per tax line (policy). */
export function intendedSale(lines: IntendedLine[], orderDiscountPercent = 0) {
  let gross = D(0), tax = D(0), tax2 = D(0);
  const byRate = new Map<number, Prisma.Decimal>();
  for (const l of lines) {
    let lineGross = D(l.unitPrice).times(l.qty);
    if (l.discountPercent) lineGross = lineGross.minus(lineGross.times(l.discountPercent).div(100));
    if (l.discountAmount) lineGross = lineGross.minus(l.discountAmount);
    if (orderDiscountPercent) lineGross = lineGross.minus(lineGross.times(orderDiscountPercent).div(100));
    lineGross = money(lineGross);
    const lineTax = l.taxRate ? money(lineGross.times(l.taxRate).div(100 + l.taxRate)) : D(0);
    if (l.taxRate) tax2 = tax2.plus(lineGross.times(l.taxRate).div(100 + l.taxRate).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP));
    gross = gross.plus(lineGross);
    tax = tax.plus(lineTax);
    byRate.set(l.taxRate, (byRate.get(l.taxRate) ?? D(0)).plus(lineTax));
  }
  return { gross, tax, net: gross.minus(tax), byRate, lines2dp: tax2 };
}

/** Recipe consumption in base stock units: Σ qty × recipe quantity. */
export function intendedConsumption(sales: Array<{ recipe: Record<string, number>; qty: number }>) {
  const out: Record<string, Prisma.Decimal> = {};
  for (const s of sales) for (const [sku, q] of Object.entries(s.recipe)) out[sku] = (out[sku] ?? D(0)).plus(D(q).times(s.qty));
  return out;
}

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_SUPPORTED';
export interface RuleResult { rule: string; status: Verdict; expected?: string; actual?: string; detail?: string }

export function compare(rule: string, expected: Prisma.Decimal.Value, actual: Prisma.Decimal.Value, detail?: string, tolerance: Prisma.Decimal.Value = 0): RuleResult {
  const ok = D(expected).minus(D(actual)).abs().lte(tolerance);
  return { rule, status: ok ? 'PASS' : 'FAIL', expected: S(expected), actual: S(actual), detail };
}
