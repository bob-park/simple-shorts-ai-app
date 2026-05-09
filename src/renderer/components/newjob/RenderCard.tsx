import type { RenderProgress as Progress, RenderClipResult, RenderResult } from '@shared/render';

function formatPercent(p: Progress): string {
  return `${Math.round(p.fraction * 100)}%`;
}

type Props =
  | { status: 'idle'; onStart: () => void }
  | { status: 'rendering'; progress: Progress | null; onCancel: () => void }
  | {
      status: 'done';
      result: RenderResult;
      onRevealDir: () => void;
      onReset: () => void;
    }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'missing-prereq'; error: Error; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function RenderCard(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">숏츠 렌더링</h3>
          <p className="text-body-sm text-slate">
            추출된 하이라이트 구간을 9:16 비율 mp4 파일로 변환합니다. 화자 얼굴을 자동으로 따라가며 중앙에 배치합니다.
          </p>
          <button
            type="button"
            onClick={props.onStart}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            숏츠 만들기
          </button>
        </div>
      ) : null}

      {props.status === 'rendering' ? (
        <div className="gap-md flex flex-col">
          <div className="gap-md flex items-baseline justify-between">
            <h3 className="text-card-title text-ink font-semibold">
              렌더링 중
              {props.progress
                ? ` (클립 ${props.progress.clipIndex}/${props.progress.clipTotal} · ${formatPercent(props.progress)})`
                : '...'}
            </h3>
          </div>
          <div className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{
                width: props.progress
                  ? `${Math.round(((props.progress.clipIndex - 1 + props.progress.fraction) / props.progress.clipTotal) * 100)}%`
                  : '0%',
              }}
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
          <h3 className="text-card-title text-success-text font-semibold">
            숏츠 {props.result.results.filter((r) => r.status === 'done').length}개 완성
            {(() => {
              const failedCount = props.result.results.filter((r) => r.status === 'failed').length;
              const canceledCount = props.result.results.filter((r) => r.status === 'canceled').length;
              const parts: string[] = [];
              if (failedCount > 0) parts.push(`실패 ${failedCount}개`);
              if (canceledCount > 0) parts.push(`취소 ${canceledCount}개`);
              return parts.length > 0 ? ` (${parts.join(', ')})` : '';
            })()}
          </h3>
          <ol className="gap-sm flex flex-col">
            {props.result.results.map((r: RenderClipResult) => (
              <li key={r.index} className={`p-md rounded-lg ${r.status === 'done' ? 'bg-surface' : 'bg-warning-bg'}`}>
                <p className="text-body-md text-ink font-semibold">
                  #{r.index} {r.title}{' '}
                  <span className="text-body-sm text-slate font-normal">
                    {r.status === 'done' ? '✓ 완료' : r.status === 'canceled' ? '⊘ 취소됨' : '✗ 실패'}
                  </span>
                </p>
                {r.outputPath ? <p className="text-body-sm text-slate mt-xs break-all">{r.outputPath}</p> : null}
                {r.status === 'done' && r.tracking ? (
                  <p className="text-body-sm text-slate mt-xs">🎯 얼굴 추적 {r.tracking.frames}프레임</p>
                ) : null}
                {r.status === 'done' && r.tracking === null ? (
                  <p className="text-body-sm text-slate mt-xs">⊕ 중앙 크롭 폴백 (얼굴 미감지)</p>
                ) : null}
                {r.status === 'done' && r.subtitles ? (
                  <p className="text-body-sm text-slate mt-xs">✏️ 자막 {r.subtitles.cues}개 cue</p>
                ) : null}
                {r.error ? <p className="text-body-sm text-brand-coral mt-xs">{r.error}</p> : null}
              </li>
            ))}
          </ol>
          <p className="text-body-sm text-slate break-all">{props.result.outputDir}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onRevealDir}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              폴더 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              다시 만들기
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">렌더링 취소됨</h3>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {props.status === 'missing-prereq' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">렌더링 준비 미완료</h3>
          <p className="text-body-sm text-slate">{props.error.message}</p>
          <button
            type="button"
            onClick={props.onReset}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            확인
          </button>
        </div>
      ) : null}

      {props.status === 'error' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-brand-coral font-semibold">렌더링 실패</h3>
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
