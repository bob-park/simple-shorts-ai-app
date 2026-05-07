import type { Settings, WhisperDevice, WhisperLanguage, WhisperModel } from '@shared/settings';

import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

const MODELS: { value: WhisperModel; label: string }[] = [
  { value: 'tiny', label: 'tiny (가장 빠름, 정확도 낮음)' },
  { value: 'base', label: 'base' },
  { value: 'small', label: 'small (권장)' },
  { value: 'medium', label: 'medium' },
  { value: 'large-v3', label: 'large-v3 (가장 정확, 느림)' },
];

const LANGUAGES: { value: WhisperLanguage; label: string }[] = [
  { value: 'auto', label: '자동 감지' },
  { value: 'ko', label: '한국어' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
];

const DEVICES: { value: WhisperDevice; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'cpu', label: 'CPU' },
  { value: 'cuda', label: 'CUDA (NVIDIA GPU)' },
  { value: 'metal', label: 'Metal (Apple Silicon)' },
];

export function WhisperSection({
  whisper,
  onChange,
}: {
  whisper: Settings['whisper'];
  onChange: (next: Settings['whisper']) => void;
}) {
  return (
    <SettingsCard title="Whisper 모델" description="로컬 음성 인식(STT) 설정입니다.">
      <SettingsRow label="모델 크기" hint="모델이 클수록 정확도는 올라가고 속도는 느려집니다.">
        <select
          className={SELECT_CLASS}
          value={whisper.model}
          onChange={(e) => onChange({ ...whisper, model: e.target.value as WhisperModel })}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="언어">
        <select
          className={SELECT_CLASS}
          value={whisper.language}
          onChange={(e) => onChange({ ...whisper, language: e.target.value as WhisperLanguage })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="실행 장치" hint="`자동`은 사용 가능한 가속을 자동 선택합니다.">
        <select
          className={SELECT_CLASS}
          value={whisper.device}
          onChange={(e) => onChange({ ...whisper, device: e.target.value as WhisperDevice })}
        >
          {DEVICES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsCard>
  );
}
