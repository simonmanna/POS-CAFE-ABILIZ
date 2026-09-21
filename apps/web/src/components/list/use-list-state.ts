import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebouncedValue } from '@/lib/use-debounced-value';

export type SortOrder = 'asc' | 'desc';
export interface SortState {
  by: string;
  order: SortOrder;
}

/**
 * List-page state (page, page size, search, filters, sort) kept in the URL, so
 * a filtered view survives a detail-page round trip and can be shared as a link.
 * Every filter/search/sort change resets to page 1.
 */
export function useListState<F extends Record<string, string>>(
  filterKeys: F,
  { defaultPageSize = 20 }: { defaultPageSize?: number } = {},
) {
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = Math.max(1, Number(params.get('pageSize')) || defaultPageSize);
  const search = params.get('q') ?? '';
  const sortBy = params.get('sort') ?? '';
  const sort: SortState | null = sortBy
    ? { by: sortBy, order: params.get('order') === 'desc' ? 'desc' : 'asc' }
    : null;

  const filterKeyList = Object.keys(filterKeys);
  const filterSig = filterKeyList.map((k) => params.get(k) ?? '').join('\u0001');
  const filters = useMemo(() => {
    const out = {} as F;
    for (const k of filterKeyList) (out as Record<string, string>)[k] = params.get(k) ?? '';
    return out;
    // filterSig captures every value this memo reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  const update = useCallback(
    (patch: Record<string, string | number | null>, resetPage = true) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          if (resetPage) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Search box is local so typing stays snappy; the URL follows after a debounce.
  const [searchInput, setSearchInput] = useState(search);
  const debounced = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    if (debounced.trim() !== search) update({ q: debounced.trim() });
    // Only react to the debounced value; `search` moving is a URL echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const setFilter = useCallback((key: keyof F & string, value: string) => update({ [key]: value }), [update]);
  const setFilters = useCallback((patch: Partial<F>) => update(patch as Record<string, string>), [update]);
  const clearFilters = useCallback(() => {
    setSearchInput('');
    update({ q: null, ...Object.fromEntries(filterKeyList.map((k) => [k, null])) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, filterSig]);

  const activeFilterCount = filterKeyList.filter((k) => params.get(k)).length + (search ? 1 : 0);

  return {
    page,
    pageSize,
    search,
    searchInput,
    setSearchInput,
    filters,
    setFilter,
    setFilters,
    clearFilters,
    activeFilterCount,
    sort,
    setSort: (s: SortState | null) => update({ sort: s?.by ?? null, order: s?.order ?? null }),
    setPage: (p: number) => update({ page: p <= 1 ? null : p }, false),
    setPageSize: (n: number) => update({ pageSize: n === defaultPageSize ? null : n }),
  };
}
