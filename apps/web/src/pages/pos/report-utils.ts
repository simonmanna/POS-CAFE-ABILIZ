/**
 * Shared helpers for the POS report tabs.
 *
 * These exist because every report tab used to re-implement them slightly
 * differently — which is how the same shift ended up with two different totals
 * depending on which tab you were looking at.
 */
import React from 'react';

/**
 * Sum a money column without float drift.
 *
 * `rows.reduce((s, r) => s + Number(r.total), 0)` accumulates binary rounding
 * error once the running total leaves the exactly-representable range, so a long
 * day of sales could foot to a few cents off the invoice figures. Summing whole
 * cents as integers is exact for any realistic row count.
 */
export function sumMoney<T>(rows: readonly T[], pick: (row: T) => string | number | null | undefined): number {
  let cents = 0;
  for (const row of rows) cents += Math.round(Number(pick(row) ?? 0) * 100);
  return cents / 100;
}

/** Sum a quantity column the same way (quantities carry up to 2 dp). */
export const sumQty = sumMoney;

/** Local-timezone YYYY-MM-DD. Never `toISOString()` — that is UTC. */
export function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const todayIso = (): string => isoLocal(new Date());

/** Monday of the ISO week containing the given YYYY-MM-DD. */
export function weekStartFromDay(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return isoDate;
  const dow = d.getDay();
  d.setDate(d.getDate() - dow + (dow === 0 ? -6 : 1));
  return isoLocal(d);
}

export const monthStart = (ym: string): string => ym + '-01';

/**
 * Format an ISO instant in the VIEWER's timezone.
 *
 * The API also ships a pre-formatted `time` string, but that was rendered with
 * the API host's locale and timezone — so a cloud-hosted API showed a café in
 * another zone the wrong clock time on every row.
 */
export const fmtDate = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleDateString() : '—';

export const fmtTime = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtDateTime = (iso?: string | null): string =>
  iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '—';

/** Title-case a snake_case enum value for display (`dine_in` → `Dine In`). */
export const humanise = (v?: string | null): string =>
  v ? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—';

export type SortDir = 'asc' | 'desc';

/**
 * Click-to-sort for a report table.
 *
 * Sorting happens on the loaded rows only — every report returns its full range
 * (there is no server paging), so the sorted view is the whole result, not a
 * misleading sort of one page.
 */
export function useTableSort<T>(
  rows: readonly T[],
  accessors: Record<string, (row: T) => string | number | null | undefined>,
  initialKey?: string,
  initialDir: SortDir = 'desc',
) {
  const [sortKey, setSortKey] = React.useState<string | undefined>(initialKey);
  const [dir, setDir] = React.useState<SortDir>(initialDir);

  const toggle = React.useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setDir('desc');
      return key;
    });
  }, []);

  const sorted = React.useMemo(() => {
    const get = sortKey ? accessors[sortKey] : undefined;
    if (!get) return rows as T[];
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      // Null-ish values always sort last, whichever direction is active, so an
      // unclosed shift never displaces real data at the top of the table.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn) && String(av).trim() !== '' && String(bv).trim() !== '') {
        return (an - bn) * factor;
      }
      return String(av).localeCompare(String(bv)) * factor;
    });
    // `accessors` is rebuilt each render by design; the row identity + sort
    // state is what actually changes the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, dir]);

  return { sorted, sortKey, dir, toggle };
}
