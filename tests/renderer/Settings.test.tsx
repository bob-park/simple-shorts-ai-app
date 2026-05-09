import { SettingsPage } from '@renderer/pages/Settings';
import type { Settings } from '@shared/settings';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const baseSettings: Settings = {
  paths: {
    downloads: '/Users/test/Downloads',
    workspace: '/Users/test/Documents/SimpleShortsAI/workspace',
    outputs: '/Users/test/Downloads/SimpleShortsAI',
  },
  llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
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
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
  };
  const api: Window['api'] = {
    cancelDownload: vi.fn(async () => undefined),
    clearApiKey: calls.clearApiKey,
    downloadVideo: vi.fn(async () => ({ outputPath: '/tmp/x.mp4' })),
    fetchVideoPreview: vi.fn(async () => {
      throw new Error('not used in this suite');
    }),
    getAppVersion: vi.fn(async () => '0.0.1'),
    getSettings: vi.fn(async () => baseSettings),
    hasApiKey: vi.fn(async () => false),
    onDownloadProgress: vi.fn(() => () => undefined),
    pickFolder: vi.fn(async () => null),
    resetSettings: vi.fn(async () => baseSettings),
    revealInFolder: vi.fn(async () => undefined),
    setApiKey: calls.setApiKey,
    updateSettings: calls.updateSettings,
    transcribeFile: vi.fn(async () => ({
      transcriptPath: '/tmp/x.transcript.json',
      transcript: { duration: 0, language: '', segments: [], words: [] },
    })),
    cancelTranscribe: vi.fn(async () => undefined),
    onTranscribeProgress: vi.fn(() => () => undefined),
    sidecarHealth: vi.fn(async () => ({ ok: true, modelsLoaded: [] })),
    openPath: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, 'api', { value: api, writable: true, configurable: true });
  return calls;
}

describe('SettingsPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('renders all 5 section cards once settings load', async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByRole('heading', { name: 'API & 모델' }));
    expect(screen.getByRole('heading', { name: 'API & 모델' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '경로' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Whisper 모델' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '자막 스타일' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '출력 옵션' })).toBeInTheDocument();
  });

  it('saves an updated LLM model via window.api.updateSettings', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue('anthropic/claude-sonnet-4.5'));
    const input = screen.getByDisplayValue('anthropic/claude-sonnet-4.5');
    await user.clear(input);
    await user.type(input, 'openai/gpt-4.1');
    await waitFor(() =>
      expect(calls.updateSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ llm: expect.objectContaining({ model: 'openai/gpt-4.1' }) }),
      ),
    );
  });

  it('saves an API key when the user enters one and clicks save', async () => {
    const calls = installApiMock();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => screen.getByPlaceholderText('sk-or-v1-...'));
    await user.type(screen.getByPlaceholderText('sk-or-v1-...'), 'sk-or-v1-test');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.setApiKey).toHaveBeenCalledWith('sk-or-v1-test'));
  });
});
