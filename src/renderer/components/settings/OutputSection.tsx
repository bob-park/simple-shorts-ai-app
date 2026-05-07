import type { Settings } from '@shared/settings';

import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const NUMBER_INPUT_CLASS =
  'h-10 w-32 rounded-md border border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep focus:outline-none';

export function OutputSection({
  shorts,
  onChange,
}: {
  shorts: Settings['shorts'];
  onChange: (next: Settings['shorts']) => void;
}) {
  return (
    <SettingsCard title="출력 옵션" description="새 작업을 시작할 때 기본으로 사용할 숏츠 개수와 길이 범위입니다.">
      <SettingsRow label="기본 숏츠 개수" hint="1 ~ 10 사이">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={1}
          max={10}
          value={shorts.defaultCount}
          onChange={(e) => onChange({ ...shorts, defaultCount: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="최소 길이 (초)">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={5}
          max={180}
          value={shorts.minSec}
          onChange={(e) => onChange({ ...shorts, minSec: Number(e.target.value) })}
        />
      </SettingsRow>
      <SettingsRow label="최대 길이 (초)">
        <input
          type="number"
          className={NUMBER_INPUT_CLASS}
          min={5}
          max={180}
          value={shorts.maxSec}
          onChange={(e) => onChange({ ...shorts, maxSec: Number(e.target.value) })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
