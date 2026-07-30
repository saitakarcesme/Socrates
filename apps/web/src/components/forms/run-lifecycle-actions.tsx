"use client";

import { Check, Square, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  runLifecycleCommandSchema,
  type RunMutationResponse,
  type RunResource,
} from "@socrates/contracts";
import { Button } from "@socrates/design-system";

import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

type FinishAction = "complete" | "cancel";

export function RunLifecycleActions({
  openExperiments,
  run,
}: {
  openExperiments: number;
  run: RunResource;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState<FinishAction | null>(null);
  const command = useCommandSubmission<
    { action: FinishAction; expectedVersion: number },
    RunMutationResponse
  >({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  if (run.status !== "running") return null;

  function execute(action: FinishAction) {
    const trackingPayload = {
      action,
      expectedVersion: run.version,
    };
    const payload = runLifecycleCommandSchema.parse({
      expectedVersion: run.version,
    });

    command.submit(trackingPayload, (idempotencyKey) => {
      const client = createBrowserControlPlaneClient();
      return action === "complete"
        ? client.completeRun(run.id, payload, idempotencyKey)
        : client.cancelRun(run.id, payload, idempotencyKey);
    });
  }

  if (confirmation) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-[11px] text-[var(--text-muted)] sm:inline">
          Confirm {confirmation}
        </span>
        <Button
          aria-label="Dismiss confirmation"
          disabled={command.pending}
          onClick={() => setConfirmation(null)}
          type="button"
        >
          <X className="size-3.5" />
        </Button>
        <Button
          disabled={command.pending}
          onClick={() => execute(confirmation)}
          type="button"
          variant={confirmation === "cancel" ? "danger" : "primary"}
        >
          {command.pending
            ? "Applying…"
            : confirmation === "cancel"
              ? "Confirm cancel"
              : "Confirm complete"}
        </Button>
        {command.error ? (
          <span
            className="max-w-52 text-right text-[11px] text-red-300"
            role="alert"
          >
            {command.error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button
        disabled={openExperiments > 0}
        onClick={() => setConfirmation("complete")}
        title={
          openExperiments > 0
            ? `${openExperiments} experiments are still open`
            : "Complete this measured run"
        }
        type="button"
      >
        <Check className="size-3.5" />
        Complete
      </Button>
      <Button
        onClick={() => setConfirmation("cancel")}
        type="button"
        variant="danger"
      >
        <Square className="size-3" />
        Cancel
      </Button>
    </div>
  );
}
