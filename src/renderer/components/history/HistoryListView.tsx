import type { JobSummary } from '@shared/history';

function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts: number | null): string {
  if (ts === null) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function statusLabel(s: JobSummary['status']): string {
  switch (s) {
    case 'done':
      return '✓ 완료';
    case 'partial_done':
      return '⚠ 부분 완료';
    case 'failed':
      return '✗ 실패';
    case 'canceled':
      return '⊘ 취소됨';
    default:
      return s;
  }
}

interface Props {
  jobs: JobSummary[];
  onRowClick: (jobId: string) => void;
}

export function HistoryListView({ jobs, onRowClick }: Props) {
  if (jobs.length === 0) {
    return <p className="text-body-md text-slate p-md">기록이 없습니다.</p>;
  }
  return (
    <table className="border-hairline w-full border-collapse border">
      <thead>
        <tr className="bg-surface text-body-sm text-slate text-left">
          <th className="px-md py-sm font-medium">제목</th>
          <th className="px-md py-sm font-medium">채널</th>
          <th className="px-md py-sm font-medium">길이</th>
          <th className="px-md py-sm font-medium">숏츠</th>
          <th className="px-md py-sm font-medium">상태</th>
          <th className="px-md py-sm font-medium">완료 시각</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr
            key={j.id}
            onClick={() => onRowClick(j.id)}
            className="border-hairline hover:bg-surface text-body-sm cursor-pointer border-t"
          >
            <td className="px-md py-sm text-ink font-semibold">{j.title}</td>
            <td className="px-md py-sm text-slate">{j.channel ?? '—'}</td>
            <td className="px-md py-sm text-slate">{formatDuration(j.durationSec)}</td>
            <td className="px-md py-sm text-slate">{j.shortCount}</td>
            <td className="px-md py-sm text-slate">{statusLabel(j.status)}</td>
            <td className="px-md py-sm text-slate">{formatDate(j.finishedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
