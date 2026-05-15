import type { TranscribeProgress as Progress } from '@shared/transcribe';
import type { Transcript } from '@shared/transcript';

function formatPercent(p: Progress): string {
  if (p.total <= 0) return '...';
  const pct = (p.processed / p.total) * 100;
  return `${pct.toFixed(1)}%`;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

type Props =
  | { status: 'idle'; onStart: () => void }
  | { status: 'starting' }
  | { status: 'downloading-model'; progress: Progress }
  | { status: 'transcribing'; progress: Progress; onCancel: () => void }
  | {
      status: 'done';
      transcriptPath: string;
      transcript: Transcript;
      onOpen: () => void;
      onReset: () => void;
    }
  | { status: 'canceled'; onReset: () => void }
  | { status: 'error'; error: Error; onReset: () => void };

export function TranscribeCard(props: Props) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      {props.status === 'idle' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">전사</h3>
          <p className="text-body-sm text-slate">
            다운로드된 영상의 음성을 텍스트로 변환합니다. 처음 실행 시 Whisper 모델이 다운로드됩니다.
          </p>
          <button
            type="button"
            onClick={props.onStart}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            STT 시작
          </button>
        </div>
      ) : null}

      {props.status === 'starting' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">전사 준비 중…</h3>
          <p className="text-body-sm text-slate">
            사이드카를 시작하고 Whisper 모델을 불러옵니다. 처음 실행 시 모델을 새로 다운로드하며, 모델 크기·네트워크
            속도에 따라 수 분 걸릴 수 있습니다. 진행되는 동안 창을 닫지 마세요.
          </p>
          <div role="progressbar" aria-label="모델 준비 중" className="bg-surface h-2 overflow-hidden rounded-full">
            <div className="bg-primary h-full w-1/3 animate-pulse rounded-full" />
          </div>
        </div>
      ) : null}

      {props.status === 'downloading-model' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">
            Whisper 모델 다운로드 중 {formatPercent(props.progress)}
          </h3>
          <p className="text-body-sm text-slate">
            처음 한 번만 받습니다 ({formatMB(props.progress.processed)} /{' '}
            {props.progress.total > 0 ? formatMB(props.progress.total) : '…'}). 완료될 때까지 창을 닫지 마세요.
          </p>
          <div role="progressbar" aria-label="모델 다운로드" className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{
                width:
                  props.progress.total > 0
                    ? `${Math.min(100, (props.progress.processed / props.progress.total) * 100)}%`
                    : '0%',
              }}
            />
          </div>
        </div>
      ) : null}

      {props.status === 'transcribing' ? (
        <div className="gap-md flex flex-col">
          <div className="gap-md flex items-baseline justify-between">
            <h3 className="text-card-title text-ink font-semibold">전사 중 {formatPercent(props.progress)}</h3>
            <p className="text-body-sm text-slate">
              {props.progress.processed.toFixed(1)}s / {props.progress.total.toFixed(1)}s
            </p>
          </div>
          <div className="bg-surface h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{
                width:
                  props.progress.total > 0
                    ? `${Math.min(100, (props.progress.processed / props.progress.total) * 100)}%`
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
          <h3 className="text-card-title text-success-text font-semibold">전사 완료</h3>
          <p className="text-body-sm text-slate">
            {props.transcript.segments.length}개 세그먼트 · {props.transcript.words.length}개 단어 ·{' '}
            {props.transcript.duration.toFixed(1)}초
          </p>
          <p className="text-body-sm text-slate break-all">{props.transcriptPath}</p>
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={props.onOpen}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
            >
              transcript 열기
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
            >
              새 전사
            </button>
          </div>
        </div>
      ) : null}

      {props.status === 'canceled' ? (
        <div className="gap-md flex flex-col">
          <h3 className="text-card-title text-ink font-semibold">전사 취소됨</h3>
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
          <h3 className="text-card-title text-brand-coral font-semibold">전사 실패</h3>
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
