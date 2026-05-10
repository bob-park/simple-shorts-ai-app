import { NewJobStateProvider } from '@renderer/components/NewJobStateContext';
import { NewJobPage } from '@renderer/pages/NewJob';
import type { VideoMeta } from '@shared/youtube';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const baseMeta: VideoMeta = {
  id: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  channel: 'Rick Astley',
  durationSec: 213,
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
  webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};

function installApiMock(overrides?: Partial<Window['api']>) {
  const calls = {
    fetchVideoPreview: vi.fn(async () => baseMeta),
    downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/dQw4w9WgXcQ.mp4' })),
    cancelDownload: vi.fn(async () => undefined),
    onDownloadProgress: vi.fn(() => () => undefined),
    revealInFolder: vi.fn(async () => undefined),
    transcribeFile: vi.fn(async () => ({
      transcriptPath: '/tmp/dQw4w9WgXcQ.mp4.transcript.json',
      transcript: { duration: 19, language: 'en', segments: [], words: [] },
    })),
    extractHighlights: vi.fn(async () => ({
      highlightsPath: '/tmp/dQw4w9WgXcQ.mp4.highlights.json',
      highlightSet: {
        generatedAt: '2026-05-09T00:00:00Z',
        model: 'm',
        audioPath: '/tmp/dQw4w9WgXcQ.mp4',
        highlights: [
          {
            segments: [{ start_sec: 0, end_sec: 30 }],
            title: 'Opener',
            hook: 'Strong start',
          },
        ],
      },
    })),
    renderShorts: vi.fn(async () => ({
      outputDir: '/tmp/Me at the zoo',
      results: [
        {
          index: 1,
          title: 'Opener',
          startSec: 0,
          endSec: 30,
          montageDurationSec: 30,
          status: 'done' as const,
          outputPath: '/tmp/Me at the zoo/short_1.mp4',
        },
      ],
    })),
  };
  const api: Window['api'] = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({}) as never),
    resetSettings: vi.fn(async () => ({}) as never),
    llmModelStatus: vi.fn(async () => ({ exists: true, sizeBytes: 2500000000, loaded: false })),
    llmDownloadModel: vi.fn(async () => undefined),
    onLlmDownloadProgress: vi.fn(() => () => undefined),
    pickFolder: vi.fn(async () => null),
    fetchVideoPreview: calls.fetchVideoPreview,
    downloadVideo: calls.downloadVideo,
    cancelDownload: calls.cancelDownload,
    onDownloadProgress: calls.onDownloadProgress,
    revealInFolder: calls.revealInFolder,
    transcribeFile: calls.transcribeFile,
    cancelTranscribe: vi.fn(async () => undefined),
    onTranscribeProgress: vi.fn(() => () => undefined),
    sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
    extractHighlights: calls.extractHighlights,
    cancelExtract: vi.fn(async () => undefined),
    onExtractProgress: vi.fn(() => () => undefined),
    renderShorts: calls.renderShorts,
    cancelRender: vi.fn(async () => undefined),
    onRenderProgress: vi.fn(() => () => undefined),
    openPath: vi.fn(async () => undefined),
    historyList: vi.fn(async () => []),
    historyGetDetail: vi.fn(async () => null),
    historyDelete: vi.fn(async () => undefined),
    resumeDetect: vi.fn(async (_id: string) => null),
    resumeHydrate: vi.fn(async (_p: string) => null),
    setupStatus: vi.fn(async () => 'ready' as const),
    setupRun: vi.fn(async () => undefined),
    onSetupProgress: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

describe('NewJobPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('keeps the 미리보기 button disabled until a valid YouTube URL is typed', async () => {
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    const button = screen.getByRole('button', { name: '미리보기' });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    expect(button).toBeEnabled();
  });

  it('shows the preview card after a successful fetch', async () => {
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Never Gonna Give You Up' })).toBeInTheDocument());
    expect(screen.getByText(/Rick Astley/)).toBeInTheDocument();
    expect(screen.getByText(/3:33/)).toBeInTheDocument();
  });

  it('clicking 다운로드 calls window.api.downloadVideo with the previewed URL', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => expect(calls.downloadVideo).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ'));
  });

  it('shows the STT 시작 button after download completes and triggers transcribeFile on click', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
    await user.click(screen.getByRole('button', { name: 'STT 시작' }));
    await waitFor(() => expect(calls.transcribeFile).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
  });

  it('shows the 하이라이트 추출 button after transcribe completes and triggers extractHighlights on click', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
    await user.click(screen.getByRole('button', { name: 'STT 시작' }));
    await waitFor(() => screen.getByRole('button', { name: '하이라이트 추출' }));
    await user.click(screen.getByRole('button', { name: '하이라이트 추출' }));
    await waitFor(() => expect(calls.extractHighlights).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
  });

  it('shows the 숏츠 만들기 button after highlights complete and triggers renderShorts on click', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
    await user.click(screen.getByRole('button', { name: 'STT 시작' }));
    await waitFor(() => screen.getByRole('button', { name: '하이라이트 추출' }));
    await user.click(screen.getByRole('button', { name: '하이라이트 추출' }));
    await waitFor(() => screen.getByRole('button', { name: '숏츠 만들기' }));
    await user.click(screen.getByRole('button', { name: '숏츠 만들기' }));
    await waitFor(() => expect(calls.renderShorts).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
  });

  it('shows ResumeBanner when resumeDetect returns a snapshot and hydrates on click', async () => {
    const snap = {
      url: 'https://youtu.be/dQw4w9WgXcQ',
      sourcePath: '/tmp/dQw4w9WgXcQ.mp4',
      meta: baseMeta,
      download: { outputPath: '/tmp/dQw4w9WgXcQ.mp4' },
    };
    installApiMock({ resumeDetect: vi.fn(async () => snap) });
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => expect(screen.getByText(/다운로드만 완료된 영상/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '이어서 작업' }));
    await waitFor(() => expect(screen.queryByText(/다운로드만 완료된 영상/)).not.toBeInTheDocument());
  });

  it('hides ResumeBanner when 새로 시작 is clicked', async () => {
    const snap = {
      url: 'https://youtu.be/dQw4w9WgXcQ',
      sourcePath: '/tmp/dQw4w9WgXcQ.mp4',
      meta: baseMeta,
      download: { outputPath: '/tmp/dQw4w9WgXcQ.mp4' },
    };
    installApiMock({ resumeDetect: vi.fn(async () => snap) });
    const user = userEvent.setup();
    render(
      <NewJobStateProvider>
        <NewJobPage />
      </NewJobStateProvider>,
    );
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => expect(screen.getByText(/다운로드만 완료된 영상/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '새로 시작' }));
    expect(screen.queryByText(/다운로드만 완료된 영상/)).not.toBeInTheDocument();
  });
});
