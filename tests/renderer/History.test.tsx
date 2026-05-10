import { App } from '@renderer/App';
import { HistoryPage } from '@renderer/pages/History';
import type { JobDetail, JobSummary } from '@shared/history';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// JobDetailDrawer now calls useNewJobState(); mock the module so tests that
// render <HistoryPage /> directly (without NewJobStateProvider) don't throw.
// We also export NewJobStateProvider as a passthrough for tests that render
// <App /> (which goes through AppShell → NewJobStateProvider).
const mockHydrate = vi.fn();
const idle = { status: 'idle' };
const mockNewJobState = {
  preview: { state: idle, fetch: vi.fn(), reset: vi.fn(), hydrateLoaded: vi.fn() },
  download: { state: idle, start: vi.fn(), cancel: vi.fn(), hydrateDone: vi.fn() },
  transcribe: { state: idle, start: vi.fn(), cancel: vi.fn(), hydrateDone: vi.fn() },
  highlights: { state: idle, start: vi.fn(), cancel: vi.fn(), hydrateDone: vi.fn() },
  renderShort: { state: idle, start: vi.fn(), cancel: vi.fn(), hydrateDone: vi.fn() },
  hydrate: mockHydrate,
};
vi.mock('@renderer/components/NewJobStateContext', () => ({
  // Passthrough provider — children render normally with stub state.
  NewJobStateProvider: ({ children }: { children: unknown }) => children,
  useNewJobState: () => mockNewJobState,
}));

function installApiMock(jobs: JobSummary[] = []) {
  const calls = {
    historyList: vi.fn(async () => jobs),
    historyGetDetail: vi.fn(async () => null),
    historyDelete: vi.fn(async () => undefined),
  };
  const api = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({}) as never),
    resetSettings: vi.fn(async () => ({}) as never),
    llmModelStatus: vi.fn(async () => ({ exists: true, sizeBytes: 2500000000, loaded: false })),
    llmDownloadModel: vi.fn(async () => undefined),
    onLlmDownloadProgress: vi.fn(() => () => undefined),
    pickFolder: vi.fn(async () => null),
    fetchVideoPreview: vi.fn(async () => ({}) as never),
    downloadVideo: vi.fn(async () => ({}) as never),
    cancelDownload: vi.fn(async () => undefined),
    onDownloadProgress: vi.fn(() => () => undefined),
    transcribeFile: vi.fn(async () => ({}) as never),
    cancelTranscribe: vi.fn(async () => undefined),
    onTranscribeProgress: vi.fn(() => () => undefined),
    sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
    extractHighlights: vi.fn(async () => ({}) as never),
    cancelExtract: vi.fn(async () => undefined),
    onExtractProgress: vi.fn(() => () => undefined),
    renderShorts: vi.fn(async () => ({ outputDir: '', results: [] })),
    cancelRender: vi.fn(async () => undefined),
    onRenderProgress: vi.fn(() => () => undefined),
    historyList: calls.historyList,
    historyGetDetail: calls.historyGetDetail,
    historyDelete: calls.historyDelete,
    revealInFolder: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    resumeDetect: vi.fn(async (_id: string) => null),
    resumeHydrate: vi.fn(async (_p: string) => null),
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

const fakeJob: JobSummary = {
  id: 'j1',
  videoId: 'abc',
  title: 'My Talk',
  channel: 'Bob',
  durationSec: 600,
  sourceThumb: null,
  status: 'done',
  shortCount: 3,
  createdAt: 1000,
  finishedAt: 1100,
};

describe('HistoryPage', () => {
  beforeEach(() => {
    installApiMock([fakeJob]);
  });

  it('calls historyList on mount and renders the returned jobs in list view', async () => {
    render(<HistoryPage />);
    await waitFor(() => expect(screen.getByText('My Talk')).toBeInTheDocument());
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // shortCount = 3 appears in list view
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('toggles between list and grid views', async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await waitFor(() => screen.getByText('My Talk'));
    // Default = list view, button text says "그리드 보기"
    const toggle = screen.getByRole('button', { name: '그리드 보기' });
    await user.click(toggle);
    // Now in grid view, button text flips
    await waitFor(() => expect(screen.getByRole('button', { name: '리스트 보기' })).toBeInTheDocument());
  });

  it('updates the search query on typing and re-fetches', async () => {
    const calls = installApiMock([fakeJob]);
    const user = userEvent.setup();
    render(<HistoryPage />);
    await waitFor(() => expect(calls.historyList).toHaveBeenCalled());
    const search = screen.getByPlaceholderText(/제목, 채널/);
    await user.type(search, 'AI');
    await waitFor(() => expect(calls.historyList).toHaveBeenCalledWith(expect.objectContaining({ search: 'AI' })));
  });

  it('clicks 이어서 작업 in JobDetailDrawer to call resumeHydrate', async () => {
    const fakeDetail: JobDetail = {
      job: {
        id: 'j1',
        url: 'https://youtu.be/abc',
        videoId: 'abc',
        title: 'My Talk',
        channel: 'Bob',
        durationSec: 600,
        sourcePath: '/tmp/x.mp4',
        sourceThumb: null,
        status: 'done',
        errorMessage: null,
        optionsJson: '{}',
        llmModel: null,
        whisperModel: null,
        createdAt: 1000,
        finishedAt: 1100,
      },
      shorts: [],
    };
    const snap = {
      url: 'https://youtu.be/abc',
      sourcePath: '/tmp/x.mp4',
      meta: {
        id: 'abc',
        title: 'My Talk',
        channel: 'Bob',
        durationSec: 600,
        thumbnailUrl: 'https://example.com/t.jpg',
        webpageUrl: 'https://youtu.be/abc',
      },
      download: { outputPath: '/tmp/x.mp4' },
    };
    (window.api.historyGetDetail as ReturnType<typeof vi.fn>).mockResolvedValue(fakeDetail);
    (window.api.resumeHydrate as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('link', { name: '히스토리' }));
    // Click the job row to open the drawer
    await user.click(await screen.findByText('My Talk'));
    // Wait for the drawer's resume button to appear
    const resumeBtn = await screen.findByRole('button', { name: '이어서 작업' });
    await user.click(resumeBtn);
    expect(window.api.resumeHydrate).toHaveBeenCalled();
  });
});
