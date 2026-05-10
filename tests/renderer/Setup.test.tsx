import { SetupPage } from '@renderer/pages/Setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installApiMock() {
  const setupRun = vi.fn(async () => undefined);
  const onSetupProgress = vi.fn(() => () => undefined);
  Object.defineProperty(window, 'api', {
    value: {
      setupRun,
      onSetupProgress,
      setupStatus: vi.fn(async () => 'pending' as const),
    },
    writable: true,
    configurable: true,
  });
  return { setupRun, onSetupProgress };
}

describe('SetupPage', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('renders idle state with 설치 시작 button', () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '설치 시작' })).toBeInTheDocument();
  });

  it('clicks 설치 시작 → calls setupRun and shows running state', async () => {
    const { setupRun } = installApiMock();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: '설치 시작' }));
    expect(setupRun).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/시작 중/)).toBeInTheDocument());
  });

  it('shows error state and 다시 시도 button when setupRun rejects', async () => {
    const setupRun = vi.fn(async () => {
      throw new Error('uv exited 1: missing pyo3');
    });
    Object.defineProperty(window, 'api', {
      value: { setupRun, onSetupProgress: vi.fn(() => () => undefined), setupStatus: vi.fn() },
      writable: true,
      configurable: true,
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: '설치 시작' }));
    await waitFor(() => expect(screen.getByText(/uv exited 1/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });
});
