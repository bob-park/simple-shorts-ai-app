import { useCallback, useEffect, useState } from 'react';

export type UseApiKey = {
  hasKey: boolean | null;
  setKey: (plaintext: string) => Promise<void>;
  clearKey: () => Promise<void>;
};

export function useApiKey(): UseApiKey {
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.hasApiKey().then((value) => {
      if (!cancelled) setHasKey(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setKey = useCallback(async (plaintext: string) => {
    await window.api.setApiKey(plaintext);
    setHasKey(true);
  }, []);

  const clearKey = useCallback(async () => {
    await window.api.clearApiKey();
    setHasKey(false);
  }, []);

  return { hasKey, setKey, clearKey };
}
