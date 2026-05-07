import { useState } from 'react';

import { useApiKey } from '@renderer/hooks/useApiKey';
import type { Settings } from '@shared/settings';

import { PasswordInput } from './PasswordInput';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

export function ApiModelSection({
  llm,
  onLlmChange,
}: {
  llm: Settings['llm'];
  onLlmChange: (next: Settings['llm']) => void;
}) {
  const { hasKey, setKey, clearKey } = useApiKey();
  const [draft, setDraft] = useState('');

  async function saveKey() {
    if (!draft) return;
    await setKey(draft);
    setDraft('');
  }

  return (
    <SettingsCard title="API & 모델" description="OpenRouter 키와 사용할 LLM 모델을 설정하세요.">
      <SettingsRow
        label="OpenRouter API 키"
        hint={
          hasKey === null
            ? '확인 중...'
            : hasKey
              ? '키가 저장되어 있습니다 (덮어쓰려면 새 키를 입력하세요).'
              : '아직 키가 저장되지 않았습니다.'
        }
      >
        <div className="gap-sm flex flex-col">
          <PasswordInput value={draft} onChange={setDraft} placeholder="sk-or-v1-..." />
          <div className="gap-sm flex">
            <button
              type="button"
              onClick={saveKey}
              disabled={!draft}
              className="bg-primary px-xl text-button-md text-on-primary h-10 rounded-full font-semibold disabled:opacity-50"
            >
              저장
            </button>
            {hasKey ? (
              <button
                type="button"
                onClick={() => clearKey()}
                className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
              >
                삭제
              </button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      <SettingsRow label="LLM 모델" hint="예: anthropic/claude-sonnet-4.5, openai/gpt-4.1, google/gemini-2.5-pro">
        <input
          type="text"
          value={llm.model}
          onChange={(e) => onLlmChange({ ...llm, model: e.target.value })}
          spellCheck={false}
          className="border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep h-10 w-full rounded-md border focus:outline-none"
        />
      </SettingsRow>
    </SettingsCard>
  );
}
