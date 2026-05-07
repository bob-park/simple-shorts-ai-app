import { useState } from 'react';

export function PathInput({
  value,
  onChange,
  dialogTitle,
}: {
  value: string;
  onChange: (next: string) => void;
  dialogTitle: string;
}) {
  const [busy, setBusy] = useState(false);

  async function browse() {
    setBusy(true);
    try {
      const picked = await window.api.pickFolder({ title: dialogTitle, defaultPath: value });
      if (picked) onChange(picked);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gap-sm flex">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="border-hairline bg-canvas px-md text-body-sm text-ink focus:border-brand-blue-deep h-10 flex-1 rounded-md border focus:outline-none"
      />
      <button
        type="button"
        onClick={browse}
        disabled={busy}
        className="border-ink px-xl text-button-md text-ink h-10 rounded-full border bg-transparent font-semibold disabled:opacity-50"
      >
        찾아보기
      </button>
    </div>
  );
}
