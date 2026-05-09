import { ApiModelSection } from '@renderer/components/settings/ApiModelSection';
import { OutputSection } from '@renderer/components/settings/OutputSection';
import { PathsSection } from '@renderer/components/settings/PathsSection';
import { SubtitlesSection } from '@renderer/components/settings/SubtitlesSection';
import { WhisperSection } from '@renderer/components/settings/WhisperSection';
import { useSettings } from '@renderer/hooks/useSettings';

export function SettingsPage() {
  const { settings, loading, error, update } = useSettings();

  if (loading) {
    return (
      <section className="p-section">
        <p className="text-body-md text-slate">설정 불러오는 중...</p>
      </section>
    );
  }

  if (error || !settings) {
    return (
      <section className="p-section">
        <p className="text-body-md text-brand-coral">설정을 불러올 수 없습니다: {error?.message ?? 'unknown error'}</p>
      </section>
    );
  }

  return (
    <section className="gap-xl p-section flex flex-col">
      <header>
        <h1 className="text-heading-md text-ink font-semibold">설정</h1>
        <p className="mt-md text-body-md text-slate">
          API 키, 경로, 모델, 자막 등을 한 번 설정해 두면 새 작업마다 기본값으로 쓰입니다.
        </p>
      </header>

      <ApiModelSection />
      <PathsSection paths={settings.paths} onChange={(paths) => void update({ paths })} />
      <WhisperSection whisper={settings.whisper} onChange={(whisper) => void update({ whisper })} />
      <SubtitlesSection subtitles={settings.subtitles} onChange={(subtitles) => void update({ subtitles })} />
      <OutputSection shorts={settings.shorts} onChange={(shorts) => void update({ shorts })} />
    </section>
  );
}
