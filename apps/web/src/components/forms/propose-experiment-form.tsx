"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import {
  proposeExperimentCommandSchema,
  type ExperimentMutationResponse,
  type ProposeExperimentCommand,
  type RunResource,
} from "@socrates/contracts";
import { Button } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormTextarea,
} from "@/components/forms/form-field";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

export function ProposeExperimentForm({
  projectId,
  run,
}: {
  projectId: string;
  run: RunResource;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const {
    clearError,
    error,
    pending,
    submit: submitCommand,
  } = useCommandSubmission<
    ProposeExperimentCommand,
    ExperimentMutationResponse
  >({
    onSuccess: (response) =>
      router.push(
        `/projects/${projectId}/runs/${run.id}/experiments/${response.data.experimentId}`,
      ),
    onVersionConflict: () => router.refresh(),
  });

  if (run.status !== "running") return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    clearError();
    const form = new FormData(event.currentTarget);
    const parsed = proposeExperimentCommandSchema.safeParse({
      expectedRunVersion: run.version,
      hypothesis: String(form.get("hypothesis") ?? ""),
      action: String(form.get("action") ?? ""),
      estimatedDurationMs:
        Number(form.get("estimatedDurationMinutes")) * 60_000,
      estimatedCostMinor: Number(form.get("estimatedCostMinor")),
    });

    if (!parsed.success) {
      setFieldErrors(
        parsed.error.issues.reduce<Record<string, string>>((result, issue) => {
          const field = issue.path.join(".");
          if (field && !result[field]) result[field] = issue.message;
          return result;
        }, {}),
      );
      return;
    }

    submitCommand(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().proposeExperiment(
        run.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <div className="mb-6 rounded-[6px] border border-[var(--border)] bg-[var(--surface)]">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium hover:bg-[var(--surface-hover)]"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Propose experiment
        <Plus className="size-3.5 text-[var(--text-muted)]" />
      </button>
      {open ? (
        <form
          className="space-y-4 border-t border-[var(--border)] p-4"
          noValidate
          onSubmit={submit}
        >
          <FormField
            error={fieldErrors["hypothesis"]}
            htmlFor="hypothesis"
            label="Hypothesis"
          >
            <FormTextarea
              id="hypothesis"
              maxLength={4_000}
              name="hypothesis"
              placeholder="If we change X, the primary metric should improve because Y."
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["action"]}
            htmlFor="action"
            label="Planned action"
          >
            <FormTextarea
              id="action"
              maxLength={8_000}
              name="action"
              placeholder="Describe the bounded change to test."
              required
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              error={fieldErrors["estimatedDurationMs"]}
              htmlFor="estimatedDurationMs"
              label="Estimated duration (minutes)"
            >
              <FormInput
                defaultValue="10"
                id="estimatedDurationMs"
                min={1}
                name="estimatedDurationMinutes"
                required
                step={1}
                type="number"
              />
            </FormField>
            <FormField
              error={fieldErrors["estimatedCostMinor"]}
              htmlFor="estimatedCostMinor"
              label="Estimated cost (minor units)"
            >
              <FormInput
                defaultValue="0"
                id="estimatedCostMinor"
                min={0}
                name="estimatedCostMinor"
                required
                step={1}
                type="number"
              />
            </FormField>
          </div>
          {error ? (
            <p className="text-xs leading-5 text-red-300" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button disabled={pending} type="submit" variant="primary">
              {pending ? "Proposing…" : "Create proposal"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
