import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExtractProgress } from '@shared/extract';
import type { HighlightSet } from '@shared/highlight';

export type HighlightState =
  | { status: 'probing' }
  | { status: 'idle' }
  | {
      status: 'extracting';
      audioPath: string;
      progress: ExtractProgress | null;
    }
  | {
      status: 'downloading-model';
      audioPath: string;
      processedBytes: number;
      totalBytes: number;
    }
  | { status: 'done'; audioPath: string; highlightsPath: string; highlightSet: HighlightSet }
  | { status: 'canceled'; audioPath: string }
  | { status: 'error'; audioPath: string; error: Error };

export type UseHighlights = {
  state: HighlightState;
  status: HighlightState['status'];
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useHighlights(): UseHighlights {
  // Initial state: 'probing' — we briefly check whether the sidecar is up
  // before flipping to 'idle'. The model-missing case is handled by
  // extract:run (it auto-downloads on demand and emits 'download' phase
  // progress events that we lift to 'downloading-model').
  const [state, setState] = useState<HighlightState>({ status: 'probing' });
  const abortRef = useRef(false);

  useEffect(() => {
    // No API key probe anymore — just flip to idle on mount.
    setState((current) => (current.status === 'probing' ? { status: 'idle' } : current));
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onExtractProgress((p) => {
      setState((current) => {
        // Lift download-phase events to a top-level 'downloading-model' state
        // so the card shows a download progress bar instead of the chunk UI.
        if (p.phase === 'download' && (current.status === 'extracting' || current.status === 'downloading-model')) {
          return {
            status: 'downloading-model',
            audioPath: current.audioPath,
            processedBytes: p.downloadedBytes ?? 0,
            totalBytes: p.totalBytes ?? 0,
          };
        }
        // Chunk/rerank events: only meaningful in 'extracting'. If we were
        // 'downloading-model', flip back to 'extracting' so the chunk UI
        // shows up.
        if (
          (p.phase === 'chunk' || p.phase === 'rerank') &&
          (current.status === 'extracting' || current.status === 'downloading-model')
        ) {
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
    abortRef.current = true;
    await window.api.cancelExtract();
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    void window.api.cancelExtract();
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, reset };
}
