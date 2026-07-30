"use client";

import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import {
  recordBaselineCommandSchema,
  type RecordBaselineCommand,
  type RunMutationResponse,
  type RunResource,
} from "@socrates/contracts";
import { Button, Panel } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormTextarea,
} from "@/components/forms/form-field";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

function CommandError({ message }: { message: string | null }) {
  return message ? (
    <div
      className="mt-4 rounded-[4px] border border-red-950 bg-red-950/20 px-3 py-2.5 text-xs leading-5 text-red-300"
      role="alert"
    >
      {message}
    </div>
  ) : null;
}

function BaselineForm({ run, unit }: { run: RunResource; unit: string }) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const {
    clearError,
    error,
    pending,
    submit: submitCommand,
  } = useCommandSubmission<RecordBaselineCommand, RunMutationResponse>({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    clearError();

    const form = new FormData(event.currentTarget);
    const notes = String(form.get("notes") ?? "").trim();
    const parsed = recordBaselineCommandSchema.safeParse({
      expectedVersion: run.version,
      value: {
        amount: String(form.get("amount") ?? ""),
        unit,
      },
      sampleCount: Number(form.get("sampleCount")),
      ...(notes ? { notes } : {}),
    });

    if (!parsed.success) {
      const errors = parsed.error.issues.reduce<Record<string, string>>(
        (result, issue) => {
          const field = issue.path.join(".");
          if (field && !result[field]) result[field] = issue.message;
          return result;
        },
        {},
      );
      setFieldErrors(errors);
      return;
    }

    submitCommand(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().recordBaseline(
        run.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <Panel className="mb-6 p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">Record baseline</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Freeze the comparison point before starting this run.
        </p>
      </div>
      <form
        className="grid gap-4 md:grid-cols-[minmax(0,1fr)_140px_auto] md:items-end"
        noValidate
        onSubmit={submit}
      >
        <FormField
          error={fieldErrors["value.amount"]}
          htmlFor="baseline-amount"
          label={`Metric value (${unit})`}
        >
          <FormInput
            id="baseline-amount"
            inputMode="decimal"
            name="amount"
            placeholder="2.4"
            required
          />
        </FormField>
        <FormField
          error={fieldErrors["sampleCount"]}
          htmlFor="baseline-samples"
          label="Samples"
        >
          <FormInput
            defaultValue="1"
            id="baseline-samples"
            min={1}
            name="sampleCount"
            required
            step={1}
            type="number"
          />
        </FormField>
        <Button disabled={pending} type="submit" variant="primary">
          {pending ? "Recording…" : "Record baseline"}
        </Button>
        <div className="md:col-span-3">
          <FormField
            error={fieldErrors["notes"]}
            htmlFor="baseline-notes"
            label="Measurement notes"
          >
            <FormTextarea
              className="min-h-20"
              id="baseline-notes"
              maxLength={4_000}
              name="notes"
              placeholder="Environment, device profile, and measurement conditions."
            />
          </FormField>
          <CommandError message={error} />
        </div>
      </form>
    </Panel>
  );
}

function StartRun({ run }: { run: RunResource }) {
  const router = useRouter();
  const {
    error,
    pending,
    submit: submitCommand,
  } = useCommandSubmission<{ expectedVersion: number }, RunMutationResponse>({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  return (
    <Panel className="mb-6 flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
      <div>
        <h2 className="text-sm font-semibold">Baseline recorded</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Start the run to enable experiment proposals.
        </p>
        <CommandError message={error} />
      </div>
      <Button
        disabled={pending}
        onClick={() => {
          const payload = { expectedVersion: run.version };
          submitCommand(payload, (idempotencyKey) =>
            createBrowserControlPlaneClient().startRun(
              run.id,
              payload,
              idempotencyKey,
            ),
          );
        }}
        type="button"
        variant="primary"
      >
        <Play className="size-3.5" />
        {pending ? "Starting…" : "Start run"}
      </Button>
    </Panel>
  );
}

export function RunSetupControls({
  run,
  unit,
}: {
  run: RunResource;
  unit: string;
}) {
  if (run.status !== "draft") return null;
  return run.baseline ? (
    <StartRun run={run} />
  ) : (
    <BaselineForm run={run} unit={unit} />
  );
}
