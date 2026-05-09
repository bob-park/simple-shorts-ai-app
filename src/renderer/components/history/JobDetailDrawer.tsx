import { useEffect, useState } from 'react';

import type { JobDetail } from '@shared/history';

interface Props {
  jobId: string | null;
  onClose: () => void;
  onDelete: (jobId: string) => void;
}

export function JobDetailDrawer({ jobId, onClose, onDelete }: Props) {
  const [detail, setDetail] = useState<JobDetail | null>(null);

  useEffect(() => {
    if (!jobId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.api.historyGetDetail(jobId).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!jobId) return null;

  return (
    <aside className="bg-canvas border-hairline shadow-2 fixed inset-y-0 right-0 w-[480px] overflow-y-auto border-l">
      <div className="p-xl gap-md flex flex-col">
        <div className="flex items-start justify-between">
          <h2 className="text-card-title text-ink font-semibold">{detail?.job.title ?? '로딩 중...'}</h2>
          <button type="button" onClick={onClose} className="text-body-md text-slate hover:text-ink" aria-label="Close">
            ×
          </button>
        </div>
        {detail ? (
          <>
            <p className="text-body-sm text-slate">
              {detail.job.channel ?? '—'} · 숏츠 {detail.shorts.length}개
            </p>
            <ol className="gap-sm flex flex-col">
              {detail.shorts.map((s) => (
                <li key={s.id} className="bg-surface p-md rounded-lg">
                  <p className="text-body-md text-ink font-semibold">
                    #{s.idx} {s.title}
                  </p>
                  {s.hook ? <p className="text-body-sm text-slate mt-xs">{s.hook}</p> : null}
                  <p className="text-body-sm text-slate mt-xs break-all">{s.outputPath}</p>
                </li>
              ))}
            </ol>
            <div className="gap-sm flex">
              <button
                type="button"
                onClick={() => {
                  if (detail.shorts[0]?.outputPath) {
                    void window.api.revealInFolder(detail.shorts[0].outputPath);
                  }
                }}
                className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
              >
                폴더 열기
              </button>
              <button
                type="button"
                onClick={() => {
                  onDelete(detail.job.id);
                  onClose();
                }}
                className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
              >
                삭제
              </button>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
