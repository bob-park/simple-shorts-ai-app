import { App } from '@renderer/App';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

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
