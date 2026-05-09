import type { ExtractProgress as Progress } from '@shared/extract';
import type { Highlight, HighlightSet } from '@shared/highlight';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

type Props =
  | { status: 'probing' }
  | { status: 'idle'; onStart: () => void }
  | {
      status: 'downloading-model';
      processedBytes: number;
      totalBytes: number;
    }
  | { status: 'extracting'; progress: Progress | null; onCancel: () => void }
  | {
      status: 'done';
      highlightsPath: string;
      highlightSet: HighlightSet;
      onOpenJson: () => void;
      onReset: () => void;
    }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function HighlightCard(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'probing' ? <p className="text-body-md text-slate">하이라이트 추출 준비 중...</p> : null}

      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">하이라이트 추출</h3>
          <p className="text-body-sm text-slate">
            전사된 텍스트를 로컬 Gemma 모델에 보내 시청자를 사로잡을 만한 구간을 자동으로 골라냅니다. 첫 실행 시 모델
            다운로드(약 2.5GB)가 필요합니다.
          </p>
          <button
            type="button"
            onClick={props.onStart}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            하이라이트 추출
          </button>
        </div>
      ) : null}

      {props.status === 'downloading-model' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">Gemma 모델 다운로드 중</h3>
          <p className="text-body-sm text-slate">
            {props.totalBytes > 0
              ? `${formatMb(props.processedBytes)}MB / ${formatMb(props.totalBytes)}MB`
              : '준비 중...'}
          </p>
          <div className="bg-surface h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{
                width: `${props.totalBytes > 0 ? (props.processedBytes / props.totalBytes) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="text-body-sm text-slate">한 번만 다운로드합니다. 이후엔 바로 추출이 시작됩니다.</p>
        </div>
      ) : null}

      {props.status === 'extracting' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">
            하이라이트 추출 중
            {props.progress && props.progress.phase !== 'download'
              ? ` (${props.progress.phase === 'rerank' ? '최종 선별' : `청크 ${props.progress.chunkIndex}/${props.progress.chunkTotal}`})`
              : '...'}
          </h3>
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
          <h3 className="text-card-title text-success-text font-semibold">
            하이라이트 {props.highlightSet.highlights.length}개 추출 완료
          </h3>
          <ol className="gap-sm flex flex-col">
            {props.highlightSet.highlights.map((h: Highlight, i: number) => {
              const totalSec = h.segments.reduce((acc, s) => acc + (s.end_sec - s.start_sec), 0);
              const isMulti = h.segments.length > 1;
              const rangeLabel = isMulti
                ? `${h.segments.length}개 세그먼트 · ${formatTime(totalSec)} 총길이`
                : `${formatTime(h.segments[0]!.start_sec)} – ${formatTime(h.segments[0]!.end_sec)}`;
              return (
                <li key={i} className="bg-surface p-md rounded-lg">
                  <p className="text-body-md text-ink font-semibold">
                    #{i + 1} {h.title} <span className="text-body-sm text-slate font-normal">({rangeLabel})</span>
                  </p>
                  <p className="text-body-sm text-slate mt-xs">{h.hook}</p>
                </li>
              );
            })}
          </ol>
          <p className="text-body-sm text-slate break-all">{props.highlightsPath}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onOpenJson}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              JSON 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              다시 추출
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">하이라이트 추출 취소됨</h3>
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
          <h3 className="text-card-title text-brand-coral font-semibold">하이라이트 추출 실패</h3>
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
