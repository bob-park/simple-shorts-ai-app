import { HistoryPage } from '@renderer/pages/History';
import type { JobSummary } from '@shared/history';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    hasApiKey: vi.fn(async () => false),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
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
    await waitFor(() =>
      expect(calls.historyList).toHaveBeenCalledWith(expect.objectContaining({ search: 'AI' })),
    );
  });
});
