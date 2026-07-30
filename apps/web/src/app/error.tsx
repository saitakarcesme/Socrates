"use client";

import { RotateCcw } from "lucide-react";

import { Button, Panel } from "@socrates/design-system";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Panel className="w-full max-w-md p-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-red-400">
          Unexpected error
        </div>
        <h1 className="mt-3 text-lg font-semibold tracking-[-0.02em]">
          This surface could not be loaded
        </h1>
        <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
          The workspace is still intact. Retry this request before changing any
          run or experiment state.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-[10px] text-[var(--text-subtle)]">
            Reference: {error.digest}
          </p>
        ) : null}
        <Button className="mt-5" onClick={reset} variant="primary">
          <RotateCcw className="size-3.5" />
          Try again
        </Button>
      </Panel>
    </div>
  );
}
