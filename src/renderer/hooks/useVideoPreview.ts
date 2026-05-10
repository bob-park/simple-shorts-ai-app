import { useCallback, useState } from 'react';

import type { VideoMeta } from '@shared/youtube';

export type VideoPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; url: string }
  | { status: 'loaded'; url: string; meta: VideoMeta }
  | { status: 'error'; url: string; error: Error };

export type UseVideoPreview = {
  state: VideoPreviewState;
  fetch: (url: string) => Promise<void>;
  hydrateLoaded: (url: string, meta: VideoMeta) => void;
  reset: () => void;
};

export function useVideoPreview(): UseVideoPreview {
  const [state, setState] = useState<VideoPreviewState>({ status: 'idle' });

  const fetch = useCallback(async (url: string) => {
    setState({ status: 'loading', url });
    try {
      const meta = await window.api.fetchVideoPreview(url);
      setState({ status: 'loaded', url, meta });
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      setState({ status: 'error', url, error });
    }
  }, []);

  const hydrateLoaded = useCallback((url: string, meta: VideoMeta) => {
    setState({ status: 'loaded', url, meta });
  }, []);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, fetch, hydrateLoaded, reset };
}
