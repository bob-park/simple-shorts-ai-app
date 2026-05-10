import { useEffect, useState } from 'react';

import type { SetupProgress } from '@shared/setup';
import { useNavigate } from 'react-router-dom';

type State =
  | { status: 'idle' }
  | { status: 'running'; progress: SetupProgress | null }
  | { status: 'error'; message: string };

function progressLabel(p: SetupProgress | null): string {
  if (!p) return '시작 중...';
  if (p.phase === 'venv') return 'Python 환경 만들기...';
  if (p.total === 0) return '패키지 정보 가져오는 중...';
  return `패키지 설치 중 (${p.current}/${p.total})${p.currentPackage ? ` — ${p.currentPackage}` : ''}`;
}

export function SetupPage() {
  const [state, setState] = useState<State>({ status: 'idle' });
  const navigate = useNavigate();

  useEffect(() => {
    return window.api.onSetupProgress((p) => {
      setState((cur) => (cur.status === 'running' ? { status: 'running', progress: p } : cur));
    });
  }, []);

  async function handleStart() {
    setState({ status: 'running', progress: null });
    try {
      await window.api.setupRun();
      navigate('/');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ status: 'error', message: msg });
    }
  }

  return (
    <section className="gap-xl p-section flex flex-col">
      <header>
        <h1 className="text-heading-md text-ink font-semibold">초기 설정</h1>
        <p className="mt-md text-body-md text-slate">
          처음 실행 시 사이드카(Python + 영상 처리) 환경을 설치합니다. 약 3~5분, 한 번만 진행됩니다.
        </p>
      </header>

      {state.status === 'idle' ? (
        <div className="border-hairline bg-canvas p-xxl shadow-1 gap-md flex flex-col rounded-xl border">
          <p className="text-body-md text-ink">사이드카 환경을 설치하면 모든 기능을 사용할 수 있습니다.</p>
          <button
            type="button"
            onClick={() => void handleStart()}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            설치 시작
          </button>
        </div>
      ) : null}

      {state.status === 'running' ? (
        <div className="border-hairline bg-canvas p-xxl shadow-1 gap-md flex flex-col rounded-xl border">
          <p className="text-body-md text-ink">{progressLabel(state.progress)}</p>
          <div className="bg-surface h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{ width: `${state.progress ? Math.round(state.progress.pct * 100) : 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="border-hairline bg-canvas p-xxl shadow-1 gap-md flex flex-col rounded-xl border">
          <h3 className="text-card-title text-brand-coral font-semibold">설치 실패</h3>
          <p className="text-body-sm text-slate break-all">{state.message}</p>
          <button
            type="button"
            onClick={() => void handleStart()}
            className="bg-primary px-xl text-button-md text-on-primary h-10 self-start rounded-full font-semibold"
          >
            다시 시도
          </button>
        </div>
      ) : null}
    </section>
  );
}
