import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExtractProgress, ExtractStatus } from '@shared/extract';
import type { HighlightSet } from '@shared/highlight';

export type HighlightState =
  | { status: 'probing' }
  | { status: 'missing-key' }
  | { status: 'idle' }
  | { status: 'extracting'; audioPath: string; progress: ExtractProgress | null }
  | { status: 'done'; audioPath: string; highlightsPath: string; highlightSet: HighlightSet }
  | { status: 'canceled'; audioPath: string }
  | { status: 'error'; audioPath: string; error: Error };

export type UseHighlights = {
  state: HighlightState;
  status: ExtractStatus | 'probing';
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
  /** Re-probe the API key (call after the user updates settings). */
  refreshKeyStatus: () => Promise<void>;
};

export function useHighlights(): UseHighlights {
  const [state, setState] = useState<HighlightState>({ status: 'probing' });
  const abortRef = useRef(false);

  const refreshKeyStatus = useCallback(async () => {
    const hasKey = await window.api.hasApiKey();
    setState((current) => {
      if (current.status === 'probing' || current.status === 'missing-key' || current.status === 'idle') {
        return hasKey ? { status: 'idle' } : { status: 'missing-key' };
      }
      return current;
    });
  }, []);

  useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  useEffect(() => {
    const unsubscribe = window.api.onExtractProgress((p) => {
      setState((current) => {
        if (current.status === 'extracting') {
          return { status: 'extracting', audioPath: current.audioPath, progress: p };
        }
        return current;
      });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (audioPath: string) => {
    abortRef.current = false;
    setState({ status: 'extracting', audioPath, progress: null });
    try {
      const { highlightsPath, highlightSet } = await window.api.extractHighlights(audioPath);
      if (abortRef.current) return;
      setState({ status: 'done', audioPath, highlightsPath, highlightSet });
    } catch (e: unknown) {
      if (abortRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (/api key is not set/i.test(message)) {
        setState({ status: 'missing-key' });
        return;
      }
      if (/abort|canceled/i.test(message)) {
        setState({ status: 'canceled', audioPath });
        return;
      }
      setState({
        status: 'error',
        audioPath,
        error: e instanceof Error ? e : new Error(message),
      });
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.cancelExtract();
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    void refreshKeyStatus().then(() => {
      // refreshKeyStatus already sets state, nothing else to do
    });
  }, [refreshKeyStatus]);

  return { state, status: state.status, start, cancel, reset, refreshKeyStatus };
}
