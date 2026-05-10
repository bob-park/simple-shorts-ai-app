import { useCallback, useEffect, useState } from 'react';

import type { TranscribeProgress, TranscribeStatus } from '@shared/transcribe';
import type { Transcript } from '@shared/transcript';

export type TranscribeState =
  | { status: 'idle' }
  | { status: 'starting'; audioPath: string }
  | { status: 'transcribing'; audioPath: string; progress: TranscribeProgress }
  | { status: 'done'; audioPath: string; transcriptPath: string; transcript: Transcript }
  | { status: 'canceled'; audioPath: string }
  | { status: 'error'; audioPath: string; error: Error };

export type UseTranscribe = {
  state: TranscribeState;
  status: TranscribeStatus;
  start: (audioPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  hydrateDone: (audioPath: string, transcriptPath: string, transcript: Transcript) => void;
  reset: () => void;
};

export function useTranscribe(): UseTranscribe {
  const [state, setState] = useState<TranscribeState>({ status: 'idle' });

  useEffect(() => {
    const unsubscribe = window.api.onTranscribeProgress((p) => {
      setState((current) => {
        if (current.status === 'starting' || current.status === 'transcribing') {
          return { status: 'transcribing', audioPath: current.audioPath, progress: p };
        }
        return current;
      });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (audioPath: string) => {
    setState({ status: 'starting', audioPath });
    try {
      const { transcriptPath, transcript } = await window.api.transcribeFile(audioPath);
      setState({ status: 'done', audioPath, transcriptPath, transcript });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/canceled/i.test(message)) {
        setState({ status: 'canceled', audioPath });
      } else {
        setState({
          status: 'error',
          audioPath,
          error: e instanceof Error ? e : new Error(message),
        });
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.cancelTranscribe();
  }, []);

  const hydrateDone = useCallback((audioPath: string, transcriptPath: string, transcript: Transcript) => {
    setState({ status: 'done', audioPath, transcriptPath, transcript });
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, hydrateDone, reset };
}
