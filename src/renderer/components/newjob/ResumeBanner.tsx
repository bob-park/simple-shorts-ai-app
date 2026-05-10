import type { ResumeSnapshot } from '@shared/resume';

interface Props {
  snapshot: ResumeSnapshot;
  onResume: () => void;
  onDismiss: () => void;
}

function describeProgress(snapshot: ResumeSnapshot): string {
  if (snapshot.render) return '이미 숏츠까지 만들어진 영상이에요.';
  if (snapshot.highlights) return '하이라이트 추출까지 완료된 영상이에요.';
  if (snapshot.transcript) return 'STT까지 완료된 영상이에요.';
  return '다운로드만 완료된 영상이에요.';
}

export function ResumeBanner({ snapshot, onResume, onDismiss }: Props) {
  return (
    <section className="border-hairline bg-canvas p-md border-l-brand-blue rounded-lg border border-l-4">
      <p className="text-body-md text-ink">{describeProgress(snapshot)}</p>
      <p className="text-body-sm text-slate mt-xs break-all">{snapshot.sourcePath}</p>
      <div className="gap-sm mt-md flex">
        <button
          type="button"
          onClick={onResume}
          className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold"
        >
          이어서 작업
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
        >
          새로 시작
        </button>
      </div>
    </section>
  );
}
