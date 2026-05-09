import { useEffect, useState } from 'react';

import { SettingsCard } from './SettingsCard';

interface ModelStatus {
  exists: boolean;
  sizeBytes: number;
}

const HUMAN_GB = 1024 * 1024 * 1024;
const HUMAN_MB = 1024 * 1024;

export function LlmSection() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ processed: number; total: number } | null>(null);

  async function refresh(): Promise<void> {
    const s = await window.api.llmModelStatus();
    setStatus({ exists: s.exists, sizeBytes: s.sizeBytes });
  }

  useEffect(() => {
    void refresh();
    const unsub = window.api.onLlmDownloadProgress((p) => setDownloadProgress(p));
    return () => unsub();
  }, []);

  async function handleRedownload(): Promise<void> {
    setDownloading(true);
    setDownloadProgress({ processed: 0, total: 0 });
    try {
      await window.api.llmDownloadModel();
      await refresh();
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  return (
    <SettingsCard
      title="하이라이트 모델"
      description="로컬에서 실행되는 LLM. 첫 하이라이트 추출 시 자동 다운로드됩니다."
    >
      <div className="gap-sm flex flex-col">
        <p className="text-body-md text-ink font-semibold">Gemma 3 4B (Q4_K_M)</p>
        {status === null ? (
          <p className="text-body-sm text-slate">상태 확인 중...</p>
        ) : status.exists ? (
          <p className="text-body-sm text-slate">✓ 다운로드됨 ({(status.sizeBytes / HUMAN_GB).toFixed(2)}GB)</p>
        ) : (
          <p className="text-body-sm text-slate">⚠️ 다운로드 안 됨 (~2.5GB 필요)</p>
        )}
        {downloading && downloadProgress ? (
          <div className="gap-xs flex flex-col">
            <p className="text-body-sm text-slate">
              {downloadProgress.total > 0
                ? `${(downloadProgress.processed / HUMAN_MB).toFixed(0)}MB / ${(downloadProgress.total / HUMAN_MB).toFixed(0)}MB`
                : '준비 중...'}
            </p>
            <div className="bg-surface h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-2 rounded-full transition-all"
                style={{
                  width: `${downloadProgress.total > 0 ? (downloadProgress.processed / downloadProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ) : null}
        <div className="gap-sm flex">
          <button
            type="button"
            onClick={handleRedownload}
            disabled={downloading}
            className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold disabled:opacity-50"
          >
            {downloading ? '다운로드 중...' : status?.exists ? '재다운로드' : '지금 다운로드'}
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}
