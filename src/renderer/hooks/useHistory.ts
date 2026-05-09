import { useCallback, useEffect, useState } from 'react';

import type { HistoryListQuery, JobSummary } from '@shared/history';

export type HistoryState =
  | { status: 'loading' }
  | { status: 'done'; jobs: JobSummary[] }
  | { status: 'error'; error: Error };

export function useHistory() {
  const [query, setQuery] = useState<HistoryListQuery>({
    search: '',
    sortBy: 'newest',
    statusFilter: [],
  });
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    window.api
      .historyList(query)
      .then((jobs) => {
        if (cancelled) return;
        setState({ status: 'done', jobs });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: e instanceof Error ? e : new Error(String(e)) });
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { query, setQuery, state, refresh };
}
