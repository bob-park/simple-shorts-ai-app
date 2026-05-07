import { useCallback, useEffect, useRef, useState } from 'react';

import type { DownloadProgress, DownloadStatus } from '@shared/youtube';

export type DownloadState =
  | { status: 'idle' }
  | { status: 'starting'; url: string }
  | { status: 'downloading'; url: string; progress: DownloadProgress }
  | { status: 'done'; url: string; outputPath: string }
  | { status: 'canceled'; url: string }
  | { status: 'error'; url: string; error: Error };

export type UseDownload = {
  state: DownloadState;
  status: DownloadStatus;
  start: (url: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

export function useDownload(): UseDownload {
  const [state, setState] = useState<DownloadState>({ status: 'idle' });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.api.onDownloadProgress((p) => {
      const url = urlRef.current;
      if (!url) return;
      setState({ status: 'downloading', url, progress: p });
    });
    return unsubscribe;
  }, []);

  const start = useCallback(async (url: string) => {
    urlRef.current = url;
    setState({ status: 'starting', url });
    try {
      const { outputPath } = await window.api.downloadVideo(url);
      setState({ status: 'done', url, outputPath });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (/canceled/i.test(message)) {
        setState({ status: 'canceled', url });
      } else {
        setState({ status: 'error', url, error: e instanceof Error ? e : new Error(message) });
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.cancelDownload();
  }, []);

  const reset = useCallback(() => {
    urlRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, status: state.status, start, cancel, reset };
}
