import type { ReactNode } from 'react';

export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="gap-xs flex flex-col">
      <span className="text-body-sm text-ink font-medium">{label}</span>
      {hint ? <span className="text-caption text-stone">{hint}</span> : null}
      <div>{children}</div>
    </label>
  );
}
