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
  };
  const api: Window['api'] = {
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({}) as never),
    resetSettings: vi.fn(async () => ({}) as never),
    hasApiKey: vi.fn(async () => false),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
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
    openPath: vi.fn(async () => undefined),
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
    render(<NewJobPage />);
    const button = screen.getByRole('button', { name: '미리보기' });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    expect(button).toBeEnabled();
  });

  it('shows the preview card after a successful fetch', async () => {
    const user = userEvent.setup();
    render(<NewJobPage />);
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Never Gonna Give You Up' })).toBeInTheDocument());
    expect(screen.getByText(/Rick Astley/)).toBeInTheDocument();
    expect(screen.getByText(/3:33/)).toBeInTheDocument();
  });

  it('clicking 다운로드 calls window.api.downloadVideo with the previewed URL', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<NewJobPage />);
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => expect(calls.downloadVideo).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ'));
  });

  it('shows the STT 시작 button after download completes and triggers transcribeFile on click', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<NewJobPage />);
    await user.type(screen.getByRole('textbox'), 'https://youtu.be/dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => screen.getByRole('button', { name: '다운로드' }));
    await user.click(screen.getByRole('button', { name: '다운로드' }));
    await waitFor(() => screen.getByRole('button', { name: 'STT 시작' }));
    await user.click(screen.getByRole('button', { name: 'STT 시작' }));
    await waitFor(() => expect(calls.transcribeFile).toHaveBeenCalledWith('/tmp/dQw4w9WgXcQ.mp4'));
  });
});
