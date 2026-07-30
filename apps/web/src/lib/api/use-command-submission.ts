"use client";

import { useRef, useState, useTransition } from "react";

import { ControlPlaneContractError, ControlPlaneError } from "@/lib/api/client";
import {
  idempotencyKeyFor,
  type IdempotencyKeyState,
} from "@/lib/api/idempotency";

export function useCommandSubmission<TPayload, TResult>({
  onSuccess,
  onVersionConflict,
}: {
  onSuccess: (result: TResult) => void;
  onVersionConflict?: () => void;
}) {
  const idempotency = useRef<IdempotencyKeyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(
    payload: TPayload,
    command: (idempotencyKey: string) => Promise<TResult>,
  ) {
    setError(null);
    const submission = idempotencyKeyFor(payload, idempotency.current);
    idempotency.current = submission;

    startTransition(async () => {
      try {
        const result = await command(submission.key);
        idempotency.current = null;
        onSuccess(result);
      } catch (cause) {
        if (cause instanceof ControlPlaneError) {
          if (cause.code === "version_conflict") onVersionConflict?.();
          setError(cause.message);
          return;
        }
        if (cause instanceof ControlPlaneContractError) {
          setError(
            "The control plane returned an unexpected response. Your input is preserved.",
          );
          return;
        }
        setError(
          "The control plane could not be reached. Retry to safely replay this submission.",
        );
      }
    });
  }

  return {
    clearError: () => setError(null),
    error,
    pending,
    submit,
  };
}
