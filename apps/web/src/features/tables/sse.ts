import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { getPosToken } from '@/features/pos/pos-session';
import { getApiBaseUrl } from '@/lib/api';

const SSE_URL = `${getApiBaseUrl()}/pos/tables/stream`;

export function usePosTablesStream() {
  const qc = useQueryClient();

  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    const posToken = getPosToken();
    const url = new URL(SSE_URL, window.location.origin);
    url.searchParams.set('access_token', token);
    if (posToken) url.searchParams.set('pos_token', posToken);

    const es = new EventSource(url.toString());

    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'snapshot' && Array.isArray(msg.tables)) {
          // A bare prefix match on ['pos-tables'] would ALSO overwrite the
          // zone catalog (['pos-tables','zones']) with the tables array —
          // rendering table names ("Table 1", "Bar Counter") on the Zones
          // page until the 30s zone refetch restored them. Target only actual
          // table-list queries: key[0]='pos-tables' and key[1] is the filter
          // object (useTables) — never a string ('zones' | 'stats' | 'detail').
          qc.setQueriesData(
            {
              predicate: (q) =>
                q.queryKey[0] === 'pos-tables' &&
                typeof q.queryKey[1] === 'object' &&
                q.queryKey[1] !== null,
            },
            msg.tables,
          );
          qc.setQueryData(['pos-tables', 'stats'], msg.stats);
        }
      } catch {
        // malformed event — ignore
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; on permanent failure it will stop.
      // The poll-based fallback (refetchInterval) keeps data fresh.
    };

    return () => {
      es.close();
    };
  }, [qc]);
}
