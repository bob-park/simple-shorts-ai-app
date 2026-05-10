import { type ReactNode, createContext, useContext } from 'react';

import { type UseDownload, useDownload } from '@renderer/hooks/useDownload';
import { type UseHighlights, useHighlights } from '@renderer/hooks/useHighlights';
import { type UseRender, useRender } from '@renderer/hooks/useRender';
import { type UseTranscribe, useTranscribe } from '@renderer/hooks/useTranscribe';
import { type UseVideoPreview, useVideoPreview } from '@renderer/hooks/useVideoPreview';

/**
 * Hoists the new-job pipeline state above react-router's Outlet so navigating
 * away (e.g. to History or Settings) and back doesn't unmount the hooks and
 * lose the in-progress pipeline state. The IPC progress subscriptions also
 * stay live so background events keep updating state while the user is on
 * another page.
 */
export interface NewJobState {
  preview: UseVideoPreview;
  download: UseDownload;
  transcribe: UseTranscribe;
  highlights: UseHighlights;
  renderShort: UseRender;
}

const NewJobStateCtx = createContext<NewJobState | null>(null);

export function NewJobStateProvider({ children }: { children: ReactNode }) {
  const value: NewJobState = {
    preview: useVideoPreview(),
    download: useDownload(),
    transcribe: useTranscribe(),
    highlights: useHighlights(),
    renderShort: useRender(),
  };
  return <NewJobStateCtx.Provider value={value}>{children}</NewJobStateCtx.Provider>;
}

export function useNewJobState(): NewJobState {
  const ctx = useContext(NewJobStateCtx);
  if (!ctx) {
    throw new Error('useNewJobState must be used within NewJobStateProvider');
  }
  return ctx;
}
