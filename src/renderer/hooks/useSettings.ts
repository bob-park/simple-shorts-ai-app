import { useCallback, useEffect, useState } from 'react';

import type { Settings } from '@shared/settings';

export type UseSettings = {
  settings: Settings | null;
  loading: boolean;
  error: Error | null;
  update: (patch: Partial<Settings>) => Promise<void>;
  reset: () => Promise<void>;
};

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.api.updateSettings(patch);
    setSettings(next);
  }, []);

  const reset = useCallback(async () => {
    const next = await window.api.resetSettings();
    setSettings(next);
  }, []);

  return { settings, loading, error, update, reset };
}
