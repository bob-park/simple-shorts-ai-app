import type { Settings, SubtitlePosition, TitleFontWeight } from '@shared/settings';

import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const INPUT_CLASS =
  'h-10 w-full rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

const POSITIONS: { value: SubtitlePosition; label: string }[] = [
  { value: 'bottom', label: '하단' },
  { value: 'middle', label: '중앙' },
];

const TITLE_FONT_WEIGHTS: { value: TitleFontWeight; label: string }[] = [
  { value: '400', label: '400 · Regular' },
  { value: '500', label: '500 · Medium' },
  { value: '600', label: '600 · Semibold' },
  { value: '700', label: '700 · Bold' },
  { value: '800', label: '800 · Extrabold' },
  { value: '900', label: '900 · Black' },
];

export function SubtitlesSection({
  subtitles,
  onChange,
}: {
  subtitles: Settings['subtitles'];
  onChange: (next: Settings['subtitles']) => void;
}) {
  return (
    <SettingsCard title="자막 스타일" description="숏츠에 구워넣을 자막 모양을 설정하세요.">
      <SettingsRow label="자막 사용">
        <span className="gap-xs flex items-center">
          <input
            type="checkbox"
            checked={subtitles.enabled}
            onChange={(e) => onChange({ ...subtitles, enabled: e.target.checked })}
          />
          <span className="text-body-sm text-ink">사용함</span>
        </span>
      </SettingsRow>
      <SettingsRow label="폰트 패밀리" hint="시스템에 설치된 폰트 이름을 입력하세요.">
        <input
          type="text"
          className={INPUT_CLASS}
          value={subtitles.fontFamily}
          onChange={(e) => onChange({ ...subtitles, fontFamily: e.target.value })}
        />
      </SettingsRow>
      <SettingsRow label="폰트 크기 (px, 1080×1920 기준)">
        <input
          type="number"
          className={INPUT_CLASS}
          min={16}
          max={160}
          value={subtitles.fontSize}
          onChange={(e) => onChange({ ...subtitles, fontSize: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="채움 색상">
        <input
          type="color"
          className="border-hairline bg-canvas h-10 w-20 rounded-md border"
          value={subtitles.fillColor}
          onChange={(e) => onChange({ ...subtitles, fillColor: e.target.value.toUpperCase() })}
        />
      </SettingsRow>
      <SettingsRow label="외곽선 색상">
        <input
          type="color"
          className="border-hairline bg-canvas h-10 w-20 rounded-md border"
          value={subtitles.outlineColor}
          onChange={(e) => onChange({ ...subtitles, outlineColor: e.target.value.toUpperCase() })}
        />
      </SettingsRow>
      <SettingsRow label="위치">
        <select
          className={INPUT_CLASS}
          value={subtitles.position}
          onChange={(e) => onChange({ ...subtitles, position: e.target.value as SubtitlePosition })}
        >
          {POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label="제목 폰트 크기 (px, 1080×1920 기준)">
        <input
          type="number"
          className={INPUT_CLASS}
          min={32}
          max={120}
          value={subtitles.titleFontSize}
          onChange={(e) => onChange({ ...subtitles, titleFontSize: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="제목 폰트 굵기">
        <select
          className={INPUT_CLASS}
          value={subtitles.titleFontWeight}
          onChange={(e) =>
            onChange({ ...subtitles, titleFontWeight: e.target.value as TitleFontWeight })
          }
        >
          {TITLE_FONT_WEIGHTS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsCard>
  );
}
