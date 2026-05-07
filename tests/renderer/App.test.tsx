import { App } from '@renderer/App';
import type { Settings } from '@shared/settings';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

const STUB_SETTINGS: Settings = {
  paths: { downloads: '/dl', workspace: '/ws', outputs: '/out' },
  llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5' },
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
    getAppVersion: () => Promise.resolve('0.0.0'),
    getSettings: () => Promise.resolve(STUB_SETTINGS),
    updateSettings: (patch) => Promise.resolve({ ...STUB_SETTINGS, ...patch }),
    resetSettings: () => Promise.resolve(STUB_SETTINGS),
    hasApiKey: () => Promise.resolve(false),
    setApiKey: () => Promise.resolve(),
    clearApiKey: () => Promise.resolve(),
    pickFolder: () => Promise.resolve(null),
  };
});

describe('App shell', () => {
  it('renders the sidebar with all four nav items', () => {
    render(<App />);
    expect(screen.getByRole('navigation', { name: '주 내비게이션' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '새 작업' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '작업 중' })).toBeInTheDocument();
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
