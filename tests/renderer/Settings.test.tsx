import { SettingsPage } from '@renderer/pages/Settings';
import type { Settings } from '@shared/settings';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const baseSettings: Settings = {
  paths: {
    downloads: '/Users/test/Downloads',
    workspace: '/Users/test/Documents/SimpleShortsAI/workspace',
    outputs: '/Users/test/Downloads/SimpleShortsAI',
  },
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

function installApiMock(overrides?: Partial<Window['api']>) {
  const calls = {
    updateSettings: vi.fn(async (patch: Partial<Settings>) => ({ ...baseSettings, ...patch })),
  };
  const api: Window['api'] = {
    cancelDownload: vi.fn(async () => undefined),
    llmModelStatus: vi.fn(async () => ({ exists: true, sizeBytes: 2500000000, loaded: false })),
    llmDownloadModel: vi.fn(async () => undefined),
    onLlmDownloadProgress: vi.fn(() => () => undefined),
    downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/x.mp4' })),
    fetchVideoPreview: vi.fn(async () => {
      throw new Error('not used in this suite');
    }),
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => baseSettings),
    onDownloadProgress: vi.fn(() => () => undefined),
    pickFolder: vi.fn(async () => null),
    resetSettings: vi.fn(async () => baseSettings),
    revealInFolder: vi.fn(async () => undefined),
    updateSettings: calls.updateSettings,
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
    ...overrides,
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

describe('SettingsPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('renders all 4 section cards once settings load', async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByRole('heading', { name: '경로' }));
    expect(screen.getByRole('heading', { name: '경로' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Whisper 모델' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '자막 스타일' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '출력 옵션' })).toBeInTheDocument();
  });
});
