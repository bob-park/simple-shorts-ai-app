import { TranscribeCard } from '@renderer/components/newjob/TranscribeCard';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the Windows "STT does nothing" root cause (2026-05-15).
 *
 * The `starting` state spans the entire pre-segment window: sidecar boot +
 * first-run Whisper model DOWNLOAD (hundreds of MB to several GB over the
 * network) + ctranslate2 load. It previously rendered a single static line
 * claiming "(최초 1회 수십 초 소요)" — tens of seconds — with no liveness
 * indicator. A real first-run download takes minutes; the user waited the
 * promised "수십 초", saw an unchanging line, concluded it was hung, and
 * killed the app (the log showed a working transcribe aborted by the
 * resulting `sidecar shutting down`). The fix: accurate expectations +
 * a visible liveness indicator.
 */
describe('TranscribeCard starting state', () => {
  it('sets accurate first-run expectations (download, minutes — not "수십 초")', () => {
    render(<TranscribeCard status="starting" />);
    expect(screen.getByText(/다운로드/)).toBeInTheDocument();
    expect(screen.getByText(/분/)).toBeInTheDocument();
    expect(screen.queryByText(/수십 초/)).not.toBeInTheDocument();
  });

  it('shows a liveness indicator so it does not look frozen', () => {
    render(<TranscribeCard status="starting" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});

/**
 * The coarse pulse was empirically insufficient (users still couldn't tell
 * "downloading" from "hung" over a multi-minute download and killed the app).
 * The `downloading-model` state shows REAL byte progress: a determinate bar
 * with %/MB so a long download is unmistakably advancing.
 */
describe('TranscribeCard downloading-model state', () => {
  const progress = {
    jobId: 'j',
    phase: 'model-download' as const,
    processed: 50 * 1024 * 1024,
    total: 100 * 1024 * 1024,
  };

  it('shows determinate percent and MB so the download is visibly advancing', () => {
    render(<TranscribeCard status="downloading-model" progress={progress} />);
    expect(screen.getByText(/50\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/50\.0MB \/ 100\.0MB/)).toBeInTheDocument();
  });

  it('renders a determinate progressbar whose width tracks bytes (~50%)', () => {
    render(<TranscribeCard status="downloading-model" progress={progress} />);
    const bars = screen.getAllByRole('progressbar');
    const fill = bars[bars.length - 1].firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });
});
