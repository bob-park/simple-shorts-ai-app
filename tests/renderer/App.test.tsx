import { App } from '@renderer/App';
import type { Settings } from '@shared/settings';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const STUB_SETTINGS: Settings = {
  paths: { downloads: '/dl', workspace: '/ws', outputs: '/out' },
  whisper: { model: 'small', language: 'auto', device: 'auto' },
  shorts: { defaultCount: 3, minSec: 20, maxSec: 60 },
  subtitles: {
    enabled: true,
    fontFamily: 'Pretendard',
    fontSize: 64,
    fillColor: '#FFFFFF',
    outlineColor: '#000000',
    position: 'bottom',
  },
  ui: { historyView: 'list', theme: 'light' },
};

beforeAll(() => {
  window.api = {
    cancelDownload: vi.fn(async () => undefined),
    clearApiKey: () => Promise.resolve(),
    downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/x.mp4' })),
    fetchVideoPreview: vi.fn(async () => {
      throw new Error('not used in this suite');
    }),
    getAppVersion: () => Promise.resolve('0.0.0'),
    getSettings: () => Promise.resolve(STUB_SETTINGS),
    hasApiKey: () => Promise.resolve(false),
    onDownloadProgress: vi.fn(() => () => undefined),
    pickFolder: () => Promise.resolve(null),
    resetSettings: () => Promise.resolve(STUB_SETTINGS),
    revealInFolder: vi.fn(async () => undefined),
    setApiKey: () => Promise.resolve(),
    updateSettings: (patch: Partial<Settings>) => Promise.resolve({ ...STUB_SETTINGS, ...patch }),
    transcribeFile: vi.fn(async () => ({
      transcriptPath: '/tmp/x.transcript.json',
      transcript: { duration: 0, language: '', segments: [], words: [] },
    })),
    cancelTranscribe: vi.fn(async () => undefined),
    onTranscribeProgress: vi.fn(() => () => undefined),
    sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
    extractHighlights: vi.fn(async () => ({
      highlightsPath: '/tmp/x.highlights.json',
      highlightSet: { generatedAt: '2026-05-09T00:00:00Z', model: 'm', audioPath: '/tmp/x', highlights: [] },
    })),
    cancelExtract: vi.fn(async () => undefined),
    onExtractProgress: vi.fn(() => () => undefined),
    renderShorts: vi.fn(async () => ({ outputDir: '/tmp/out', results: [] })),
    cancelRender: vi.fn(async () => undefined),
    onRenderProgress: vi.fn(() => () => undefined),
    openPath: vi.fn(async () => undefined),
    historyList: vi.fn(async () => []),
    historyGetDetail: vi.fn(async () => null),
    historyDelete: vi.fn(async () => undefined),
  } satisfies Window['api'];
});

describe('App shell', () => {
  it('renders the sidebar with all three nav items', () => {
    render(<App />);
    expect(screen.getByRole('navigation', { name: '주 내비게이션' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '새 작업' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '히스토리' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '설정' })).toBeInTheDocument();
  });

  it('shows the NewJob page on initial route', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '새 작업' })).toBeInTheDocument();
  });

  it('navigates to settings when the Settings link is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('link', { name: '설정' }));
    expect(screen.getByRole('heading', { name: '설정' })).toBeInTheDocument();
  });
});
