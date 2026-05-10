import { useCallback, useEffect, useRef, useState } from 'react';

import type { RenderProgress, RenderResult, RenderStatus } from '@shared/render';

export type RenderState =
  | { status: 'idle' }
  | { status: 'rendering'; audioPath: string; progress: RenderProgress | null }
  | { status: 'done'; audioPath: string; result: RenderResult }
  | { status: 'canceled'; audioPath: string }
  | { status: 'missing-prereq'; audioPath: string; error: Error }
  | { status: 'error'; audioPath: string; error: Error };

export type UseRender = {
  state: RenderState;
  status: RenderStatus | 'idle';
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  hydrateDone: (audioPath: string, result: RenderResult) => void;
  reset: () => void;
};

export function useRender(): UseRender {
  const [state, setState] = useState<RenderState>({ status: 'idle' });
  const abortRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.api.onRenderProgress((p) => {
      setState((current) => {
        if (current.status === 'rendering') {
          return { status: 'rendering', audioPath: current.audioPath, progress: p };
        }
        return current;
      });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (audioPath: string) => {
    abortRef.current = false;
    setState({ status: 'rendering', audioPath, progress: null });
    try {
      const result = await window.api.renderShorts(audioPath);
      if (abortRef.current) return;
      setState({ status: 'done', audioPath, result });
    } catch (e: unknown) {
      if (abortRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      const err = e instanceof Error ? e : new Error(message);
      if (/no highlights found|ffmpeg is not on path/i.test(message)) {
        setState({ status: 'missing-prereq', audioPath, error: err });
        return;
      }
      if (/abort|canceled/i.test(message)) {
        setState({ status: 'canceled', audioPath });
        return;
      }
      setState({ status: 'error', audioPath, error: err });
    }
  }, []);

  const cancel = useCallback(async () => {
    // Don't set abortRef — RenderService resolves with a partial RenderResult
    // (some clips done, rest canceled) instead of throwing, so we want the
    // success path in `start()` to land that result as `'done'` state. The
    // RenderCard then shows per-clip "⊘ 취소됨" markers next to "✓ 완료".
    await window.api.cancelRender();
  }, []);

  const hydrateDone = useCallback((audioPath: string, result: RenderResult) => {
    abortRef.current = true;
    setState({ status: 'done', audioPath, result });
  }, []);

  const reset = useCallback(() => {
    // reset DOES set abortRef so the success path's late setState is ignored
    // — we want to discard the result entirely and return to 'idle'.
    abortRef.current = true;
    void window.api.cancelRender();
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, hydrateDone, reset };
}
