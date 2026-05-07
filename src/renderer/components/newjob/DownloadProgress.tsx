import type { DownloadProgress as Progress } from '@shared/youtube';

function formatEta(sec: number | null): string {
  if (sec === null) return '--:--';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(b: number | null): string {
  if (b === null) return '--';
  if (b > 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

type Props =
  | { status: 'starting' }
  | { status: 'downloading'; progress: Progress; onCancel: () => void }
  | { status: 'done'; outputPath: string; onReveal: () => void; onReset: () => void }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function DownloadProgress(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'starting' ? <p className="text-body-md text-slate">다운로드 준비 중...</p> : null}

      {props.status === 'downloading' ? (
        <div className="gap-md flex flex-col">
          <div className="gap-md flex items-baseline justify-between">
            <h3 className="text-card-title text-ink font-semibold">{props.progress.percent.toFixed(1)}%</h3>
            <p className="text-body-sm text-slate">
              {formatBytes(props.progress.downloadedBytes)} / {formatBytes(props.progress.totalBytes)} · ETA{' '}
              {formatEta(props.progress.etaSec)}
            </p>
          </div>
          <div className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{ width: `${Math.min(100, props.progress.percent)}%` }}
            />
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="border-ink px-xl text-button-md text-ink h-10 self-start rounded-full border bg-transparent font-semibold"
          >
            취소
          </button>
        </div>
      ) : null}

      {props.status === 'done' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-success-text font-semibold">다운로드 완료</h3>
          <p className="text-body-sm text-slate break-all">{props.outputPath}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onReveal}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              파일 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              새 작업
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">취소됨</h3>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {props.status === 'error' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-brand-coral font-semibold">실패</h3>
          <p className="text-body-sm text-slate break-all">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}
