/**
 * Attendance calendar helpers, in the organisation's time zone.
 *
 * Attendance used to bucket days with the server's local midnight
 * (`new Date(y, m, d)`) and read shift times with `getHours()`. On a server
 * running in UTC that put a 01:30 Kampala clock-in on the previous day and
 * made every lateness figure three hours off.
 *
 * An attendance `date` is now the organisation's calendar day, stored as that
 * date at UTC midnight. On a UTC server this is exactly what the old code
 * wrote, so existing rows keep matching.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD for an instant, in the given zone. */
function calendarDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The attendance day an instant (or a date input) belongs to. A bare
 * `YYYY-MM-DD` is already a calendar day and is taken as-is.
 */
export function attendanceDay(value: Date | string, timeZone: string): Date {
  if (typeof value === 'string') {
    const v = value.trim();
    if (DATE_ONLY.test(v)) return new Date(`${v}T00:00:00.000Z`);
    value = new Date(v);
  }
  return new Date(`${calendarDay(value, timeZone)}T00:00:00.000Z`);
}

/** Shift a stored attendance day by whole days. */
export function addDays(day: Date, days: number): Date {
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Minutes since local midnight for an instant, in the given zone. */
export function minutesOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** The organisation's IANA zone, or UTC when unset or invalid. */
export async function hrTimezone(
  client: { organization?: { findUnique: (args: any) => Promise<any> } },
  organizationId: string,
): Promise<string> {
  const org = await client.organization?.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  const tz = org?.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}
