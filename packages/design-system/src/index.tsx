import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[4px] border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" &&
          "border-white bg-white text-black hover:bg-neutral-200",
        variant === "secondary" &&
          "border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-hover)]",
        variant === "ghost" &&
          "border-transparent bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
        variant === "danger" &&
          "border-red-950 bg-red-950/30 text-red-400 hover:bg-red-950/60",
        className,
      )}
      {...props}
    />
  );
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[6px] border border-[var(--border)] bg-[var(--surface)]",
        className,
      )}
      {...props}
    />
  );
}

type StatusTone = "neutral" | "running" | "success" | "warning" | "danger";

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-[3px] border px-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em]",
        tone === "neutral" &&
          "border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-muted)]",
        tone === "running" && "border-blue-950 bg-blue-950/40 text-blue-400",
        tone === "success" &&
          "border-emerald-950 bg-emerald-950/40 text-emerald-400",
        tone === "warning" && "border-amber-950 bg-amber-950/40 text-amber-400",
        tone === "danger" && "border-red-950 bg-red-950/40 text-red-400",
      )}
    >
      <span aria-hidden="true" className="size-1 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-subtle)]">
        {label}
      </div>
      <div className="font-mono text-xl tracking-[-0.04em] text-[var(--text)]">
        {value}
      </div>
      {detail ? (
        <div className="mt-1 text-xs text-[var(--text-muted)]">{detail}</div>
      ) : null}
    </div>
  );
}
