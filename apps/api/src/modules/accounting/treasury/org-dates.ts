import { BadRequestException } from '@nestjs/common';
import { zonedDayRange } from './cash-session.service';

/**
 * Calendar dates for money screens are the organisation's calendar, not UTC.
 * A Kampala sale at 01:30 belongs to that local day, so "Today" on the
 * overview, the activity feed, settlements and reports must all bound days in
 * the organisation time zone.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Load the organisation's IANA time zone (UTC when unset or invalid). */
export async function orgTimezone(prisma: { client: any }, organizationId: string): Promise<string> {
  const org = await prisma.client.organization?.findUnique({ where: { id: organizationId }, select: { timezone: true } });
  const tz = (org as any)?.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function orgToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Parse a filter bound. A bare `YYYY-MM-DD` is a local calendar day: `start`
 * returns its first instant, `end` its last millisecond (inclusive, so callers
 * keep `<=`). Full ISO timestamps are taken as-is.
 */
export function orgDateBound(value: string | undefined, label: string, timeZone: string, edge: 'start' | 'end'): Date | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (DATE_ONLY.test(v)) {
    const { start, end } = zonedDayRange(v, timeZone);
    return edge === 'start' ? start : new Date(end.getTime() - 1);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid \`${label}\` date: ${value}`);
  return d;
}

/**
 * The instant to post a manual money operation dated `value`. Today's date
 * posts now; another bare date posts at local noon so the entry cannot slip to
 * a neighbouring day in any time zone. Future dates are rejected.
 */
export function orgPostingInstant(value: string | undefined, timeZone: string, now = new Date()): Date {
  if (!value) return now;
  const v = value.trim();
  if (!DATE_ONLY.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid date: ${value}`);
    return d;
  }
  const today = orgToday(timeZone, now);
  if (v > today) throw new BadRequestException('The date cannot be in the future');
  if (v === today) return now;
  const { start } = zonedDayRange(v, timeZone);
  return new Date(start.getTime() + 12 * 60 * 60 * 1000);
}

/** Trading day starts at 06:00 local: a sale at 00:30 belongs to the previous trading day. */
export const TRADING_DAY_START_HOUR = 6;

/**
 * The trading date (a calendar date at UTC midnight, for a DATE column) that an
 * instant belongs to in the organisation's time zone, with the trading day
 * starting at {@link TRADING_DAY_START_HOUR}.
 */
export function tradingDate(at: Date, timeZone: string, startHour = TRADING_DAY_START_HOUR): Date {
  const shifted = new Date(at.getTime() - startHour * 3_600_000);
  return new Date(`${orgToday(timeZone, shifted)}T00:00:00.000Z`);
}
