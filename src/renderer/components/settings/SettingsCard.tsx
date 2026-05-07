import type { ReactNode } from 'react';

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-hairline bg-canvas p-xxl shadow-1 rounded-xl border">
      <header className="mb-xl">
        <h2 className="text-card-title text-ink font-semibold">{title}</h2>
        {description ? <p className="mt-xxs text-body-sm text-slate">{description}</p> : null}
      </header>
      <div className="gap-lg flex flex-col">{children}</div>
    </section>
  );
}
