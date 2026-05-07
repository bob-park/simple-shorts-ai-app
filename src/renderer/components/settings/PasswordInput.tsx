import { useState } from 'react';

export function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="gap-sm flex">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep h-10 flex-1 rounded-md border focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold"
      >
        {shown ? '숨기기' : '표시'}
      </button>
    </div>
  );
}
