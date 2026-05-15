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
