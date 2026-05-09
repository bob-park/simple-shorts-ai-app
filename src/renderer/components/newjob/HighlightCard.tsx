import type { ExtractProgress as Progress } from '@shared/extract';
import type { Highlight, HighlightSet } from '@shared/highlight';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

type Props =
  | { status: 'probing' }
  | { status: 'missing-key'; onOpenSettings: () => void }
  | { status: 'idle'; onStart: () => void }
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

      {props.status === 'missing-key' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">하이라이트 추출</h3>
          <p className="text-body-sm text-slate">
            OpenRouter API 키가 설정되어 있지 않습니다. 설정 페이지에서 키를 등록한 뒤 다시 시도하세요.
          </p>
          <button
            type="button"
            onClick={props.onOpenSettings}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            설정으로 이동
          </button>
        </div>
      ) : null}

      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">하이라이트 추출</h3>
          <p className="text-body-sm text-slate">
            전사된 텍스트를 LLM에 보내 시청자를 사로잡을 만한 구간을 자동으로 골라냅니다.
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

      {props.status === 'extracting' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">
            하이라이트 추출 중
            {props.progress
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
            {props.highlightSet.highlights.map((h: Highlight, i: number) => (
              <li key={i} className="bg-surface p-md rounded-lg">
                <p className="text-body-md text-ink font-semibold">
                  #{i + 1} {h.title}{' '}
                  <span className="text-body-sm text-slate font-normal">
                    ({formatTime(h.start_sec)} – {formatTime(h.end_sec)})
                  </span>
                </p>
                <p className="text-body-sm text-slate mt-xs">{h.hook}</p>
              </li>
            ))}
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
