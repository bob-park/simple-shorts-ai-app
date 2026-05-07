import type { VideoMeta } from '@shared/youtube';

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PreviewCard({
  meta,
  onDownload,
  onClear,
  downloadDisabled,
}: {
  meta: VideoMeta;
  onDownload: () => void;
  onClear: () => void;
  downloadDisabled?: boolean;
}) {
  return (
    <article className="border-hairline bg-canvas shadow-1 overflow-hidden rounded-xl border">
      <img src={meta.thumbnailUrl} alt="" className="aspect-video w-full object-cover" loading="lazy" />
      <div className="gap-md p-xxl flex flex-col">
        <header className="gap-xs flex flex-col">
          <h2 className="text-card-title text-ink font-semibold">{meta.title}</h2>
          <p className="text-body-sm text-slate">
            {meta.channel} · {formatDuration(meta.durationSec)}
          </p>
        </header>
        <div className="gap-sm flex">
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadDisabled}
            className="bg-primary px-xl text-button-md text-on-primary h-12 rounded-full font-semibold disabled:opacity-50"
          >
            다운로드
          </button>
          <button
            type="button"
            onClick={onClear}
            className="border-ink px-xl text-button-md text-ink h-12 rounded-full border bg-transparent font-semibold"
          >
            URL 변경
          </button>
        </div>
      </div>
    </article>
  );
}
