import { DownloadProgress } from '@renderer/components/newjob/DownloadProgress';
import { HighlightCard } from '@renderer/components/newjob/HighlightCard';
import { PreviewCard } from '@renderer/components/newjob/PreviewCard';
import { TranscribeCard } from '@renderer/components/newjob/TranscribeCard';
import { UrlInput } from '@renderer/components/newjob/UrlInput';
import { useDownload } from '@renderer/hooks/useDownload';
import { useHighlights } from '@renderer/hooks/useHighlights';
import { useTranscribe } from '@renderer/hooks/useTranscribe';
import { useVideoPreview } from '@renderer/hooks/useVideoPreview';
import { useNavigate } from 'react-router-dom';

export function NewJobPage() {
  const preview = useVideoPreview();
  const download = useDownload();
  const transcribe = useTranscribe();
  const highlights = useHighlights();
  const navigate = useNavigate();

  const downloadInFlight = download.status === 'starting' || download.status === 'downloading';

  return (
    <section className="gap-xl p-section flex flex-col">
      <header>
        <h1 className="text-heading-md text-ink font-semibold">새 작업</h1>
        <p className="mt-md text-body-md text-slate">
          YouTube URL을 입력하면 영상 정보를 미리 확인하고 다운로드할 수 있습니다.
        </p>
      </header>

      <UrlInput
        onSubmit={(url) => void preview.fetch(url)}
        disabled={preview.state.status === 'loading' || downloadInFlight}
      />

      {preview.state.status === 'loading' ? <p className="text-body-md text-slate">영상 정보 가져오는 중...</p> : null}

      {preview.state.status === 'error' ? (
        <p className="text-body-md text-brand-coral">영상 정보를 불러오지 못했습니다: {preview.state.error.message}</p>
      ) : null}

      {preview.state.status === 'loaded' && download.state.status === 'idle' ? (
        <PreviewCard
          meta={preview.state.meta}
          onDownload={() => {
            if (preview.state.status === 'loaded') void download.start(preview.state.url);
          }}
          onClear={() => preview.reset()}
        />
      ) : null}

      {download.state.status === 'starting' ? <DownloadProgress status="starting" /> : null}

      {download.state.status === 'downloading' ? (
        <DownloadProgress
          status="downloading"
          progress={download.state.progress}
          onCancel={() => void download.cancel()}
        />
      ) : null}

      {download.state.status === 'done' ? (
        <>
          <DownloadProgress
            status="done"
            outputPath={download.state.outputPath}
            onReveal={() => {
              if (download.state.status === 'done') void window.api.revealInFolder(download.state.outputPath);
            }}
            onReset={() => {
              download.reset();
              preview.reset();
              transcribe.reset();
            }}
          />
          {transcribe.state.status === 'idle' ? (
            <TranscribeCard
              status="idle"
              onStart={() => {
                if (download.state.status === 'done') void transcribe.start(download.state.outputPath);
              }}
            />
          ) : null}
          {transcribe.state.status === 'starting' ? <TranscribeCard status="starting" /> : null}
          {transcribe.state.status === 'transcribing' ? (
            <TranscribeCard
              status="transcribing"
              progress={transcribe.state.progress}
              onCancel={() => void transcribe.cancel()}
            />
          ) : null}
          {transcribe.state.status === 'done' ? (
            <>
              <TranscribeCard
                status="done"
                transcriptPath={transcribe.state.transcriptPath}
                transcript={transcribe.state.transcript}
                onOpen={() => {
                  if (transcribe.state.status === 'done') void window.api.openPath(transcribe.state.transcriptPath);
                }}
                onReset={() => {
                  transcribe.reset();
                  highlights.reset();
                }}
              />
              {highlights.state.status === 'probing' ? <HighlightCard status="probing" /> : null}
              {highlights.state.status === 'missing-key' ? (
                <HighlightCard status="missing-key" onOpenSettings={() => navigate('/settings')} />
              ) : null}
              {highlights.state.status === 'idle' ? (
                <HighlightCard
                  status="idle"
                  onStart={() => {
                    if (transcribe.state.status === 'done') void highlights.start(transcribe.state.audioPath);
                  }}
                />
              ) : null}
              {highlights.state.status === 'extracting' ? (
                <HighlightCard
                  status="extracting"
                  progress={highlights.state.progress}
                  onCancel={() => void highlights.cancel()}
                />
              ) : null}
              {highlights.state.status === 'done' ? (
                <HighlightCard
                  status="done"
                  highlightsPath={highlights.state.highlightsPath}
                  highlightSet={highlights.state.highlightSet}
                  onOpenJson={() => {
                    if (highlights.state.status === 'done') void window.api.openPath(highlights.state.highlightsPath);
                  }}
                  onReset={() => highlights.reset()}
                />
              ) : null}
              {highlights.state.status === 'canceled' ? (
                <HighlightCard status="canceled" onReset={() => highlights.reset()} />
              ) : null}
              {highlights.state.status === 'error' ? (
                <HighlightCard status="error" error={highlights.state.error} onReset={() => highlights.reset()} />
              ) : null}
            </>
          ) : null}
          {transcribe.state.status === 'canceled' ? (
            <TranscribeCard status="canceled" onReset={() => transcribe.reset()} />
          ) : null}
          {transcribe.state.status === 'error' ? (
            <TranscribeCard status="error" error={transcribe.state.error} onReset={() => transcribe.reset()} />
          ) : null}
        </>
      ) : null}

      {download.state.status === 'canceled' ? (
        <DownloadProgress
          status="canceled"
          onReset={() => {
            download.reset();
            preview.reset();
          }}
        />
      ) : null}

      {download.state.status === 'error' ? (
        <DownloadProgress
          status="error"
          error={download.state.error}
          onReset={() => {
            download.reset();
            preview.reset();
          }}
        />
      ) : null}
    </section>
  );
}
