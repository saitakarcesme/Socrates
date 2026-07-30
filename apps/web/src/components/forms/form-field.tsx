import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const controlClassName =
  "mt-2 w-full rounded-[4px] border border-[var(--border-strong)] bg-[var(--canvas)] px-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)] focus:border-neutral-500 focus:ring-1 focus:ring-neutral-700";

export function FormField({
  children,
  description,
  error,
  htmlFor,
  label,
}: {
  children: ReactNode;
  description?: string;
  error?: string;
  htmlFor: string;
  label: string;
}) {
  const descriptionId = `${htmlFor}-description`;
  const errorId = `${htmlFor}-error`;

  return (
    <div>
      <label className="block text-xs font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1.5 text-[11px] leading-4 text-red-400" id={errorId}>
          {error}
        </p>
      ) : description ? (
        <p
          className="mt-1.5 text-[11px] leading-4 text-[var(--text-subtle)]"
          id={descriptionId}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function FormInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`${controlClassName} h-9 ${className ?? ""}`}
      {...props}
    />
  );
}

export function FormTextarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`${controlClassName} min-h-28 resize-y py-2.5 ${className ?? ""}`}
      {...props}
    />
  );
}

export function FormSelect({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${controlClassName} h-9 ${className ?? ""}`}
      {...props}
    />
  );
}
