import type { Settings } from '@shared/settings';

import { PathInput } from './PathInput';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

export function PathsSection({
  paths,
  onChange,
}: {
  paths: Settings['paths'];
  onChange: (next: Settings['paths']) => void;
}) {
  return (
    <SettingsCard title="경로" description="다운로드한 원본·작업 파일·완성된 숏츠가 저장될 위치입니다.">
      <SettingsRow label="다운로드 폴더" hint="YouTube에서 받아온 원본 영상이 저장됩니다.">
        <PathInput
          value={paths.downloads}
          onChange={(downloads) => onChange({ ...paths, downloads })}
          dialogTitle="다운로드 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="작업 폴더" hint="처리 중 임시 파일과 로그가 저장됩니다.">
        <PathInput
          value={paths.workspace}
          onChange={(workspace) => onChange({ ...paths, workspace })}
          dialogTitle="작업 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="출력 폴더" hint="완성된 숏츠 영상이 저장됩니다.">
        <PathInput
          value={paths.outputs}
          onChange={(outputs) => onChange({ ...paths, outputs })}
          dialogTitle="출력 폴더 선택"
        />
      </SettingsRow>
      <SettingsRow label="진단 로그" hint="STT/사이드카 오류 진단용 로그 파일 위치입니다. 문제 보고 시 첨부하세요.">
        <button
          type="button"
          onClick={() => void window.api.openLogsFolder()}
          className="border-ink px-xl text-button-md text-ink h-10 self-start rounded-full border bg-transparent font-semibold"
        >
          로그 폴더 열기
        </button>
      </SettingsRow>
    </SettingsCard>
  );
}
