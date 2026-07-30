import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-28 flex-col gap-5 border-b border-[var(--border)] px-6 py-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8 sm:px-8">
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <div className="mb-2 text-xs text-[var(--text-muted)]">{eyebrow}</div>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-[var(--text)]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[var(--text-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="shrink-0 self-stretch sm:self-auto">{actions}</div>
      ) : null}
    </header>
  );
}
