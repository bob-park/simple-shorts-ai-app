import { type ReactNode, createContext, useContext, useMemo } from 'react';

import { type UseDownload, useDownload } from '@renderer/hooks/useDownload';
import { type UseHighlights, useHighlights } from '@renderer/hooks/useHighlights';
import { type UseRender, useRender } from '@renderer/hooks/useRender';
import { type UseTranscribe, useTranscribe } from '@renderer/hooks/useTranscribe';
import { type UseVideoPreview, useVideoPreview } from '@renderer/hooks/useVideoPreview';
import type { ResumeSnapshot } from '@shared/resume';

/**
 * Hoists the new-job pipeline state above react-router's Outlet so navigating
 * away (e.g. to History or Settings) and back doesn't unmount the hooks and
 * lose the in-progress pipeline state. The IPC progress subscriptions also
 * stay live so background events keep updating state while the user is on
 * another page.
 *
 * Also exposes a `hydrate(snapshot)` entry point for the resume-prior-job
 * feature: callers (URL re-paste banner, History "이어서 작업" button) push
 * a ResumeSnapshot in and the relevant hooks jump straight to their done
 * states.
 */
export interface NewJobState {
  preview: UseVideoPreview;
  download: UseDownload;
  transcribe: UseTranscribe;
  highlights: UseHighlights;
  renderShort: UseRender;
  hydrate: (snapshot: ResumeSnapshot) => void;
}

const NewJobStateCtx = createContext<NewJobState | null>(null);

export function NewJobStateProvider({ children }: { children: ReactNode }) {
  const preview = useVideoPreview();
  const download = useDownload();
  const transcribe = useTranscribe();
  const highlights = useHighlights();
  const renderShort = useRender();

  const value = useMemo<NewJobState>(
    () => ({
      preview,
      download,
      transcribe,
      highlights,
      renderShort,
      hydrate(snapshot) {
        preview.hydrateLoaded(snapshot.url, snapshot.meta);
        download.hydrateDone(snapshot.url, snapshot.download.outputPath);
        if (snapshot.transcript) {
          transcribe.hydrateDone(snapshot.sourcePath, snapshot.transcript.path, snapshot.transcript.data);
        }
        if (snapshot.highlights) {
          highlights.hydrateDone(snapshot.sourcePath, snapshot.highlights.path, snapshot.highlights.data);
        }
        if (snapshot.render) {
          renderShort.hydrateDone(snapshot.sourcePath, snapshot.render.result);
        }
      },
    }),
    [preview, download, transcribe, highlights, renderShort],
  );

  return <NewJobStateCtx.Provider value={value}>{children}</NewJobStateCtx.Provider>;
}

export function useNewJobState(): NewJobState {
  const ctx = useContext(NewJobStateCtx);
  if (!ctx) {
    throw new Error('useNewJobState must be used within NewJobStateProvider');
  }
  return ctx;
}
