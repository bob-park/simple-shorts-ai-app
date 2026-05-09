import type { JobSummary } from '@shared/history';

interface Props {
  jobs: JobSummary[];
  onRowClick: (jobId: string) => void;
}

export function HistoryGridView({ jobs, onRowClick }: Props) {
  if (jobs.length === 0) {
    return <p className="text-body-md text-slate p-md">기록이 없습니다.</p>;
  }
  return (
    <div className="gap-lg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {jobs.map((j) => (
        <button
          key={j.id}
          type="button"
          onClick={() => onRowClick(j.id)}
          className="bg-canvas border-hairline hover:shadow-2 cursor-pointer overflow-hidden rounded-xl border text-left transition-shadow"
        >
          <div className="bg-surface aspect-video w-full">
            {j.sourceThumb ? (
              <img src={j.sourceThumb} alt={j.title} className="h-full w-full object-cover" loading="lazy" />
            ) : null}
          </div>
          <div className="p-md gap-xs flex flex-col">
            <p className="text-body-md text-ink line-clamp-2 font-semibold">{j.title}</p>
            <p className="text-body-sm text-slate">
              {j.channel ?? '—'} · 숏츠 {j.shortCount}개
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
