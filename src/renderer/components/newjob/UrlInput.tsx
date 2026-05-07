import { useState } from 'react';

import { isYoutubeUrl } from '@shared/youtube';

export function UrlInput({
  initialValue,
  onSubmit,
  disabled,
}: {
  initialValue?: string;
  onSubmit: (url: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  const trimmed = value.trim();
  const valid = isYoutubeUrl(trimmed);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || disabled) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="gap-sm flex">
      <input
        type="url"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        placeholder="https://www.youtube.com/watch?v=..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="border-hairline bg-canvas px-xl text-body-md text-ink focus:border-brand-blue-deep h-12 flex-1 rounded-full border focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!valid || disabled}
        className="bg-primary px-xl text-button-md text-on-primary h-12 rounded-full font-semibold disabled:opacity-50"
      >
        미리보기
      </button>
    </form>
  );
}
