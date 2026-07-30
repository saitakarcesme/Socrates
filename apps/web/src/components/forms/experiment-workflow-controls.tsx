"use client";

import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";

import {
  createLearningCommandSchema,
  decideExperimentCommandSchema,
  experimentLifecycleCommandSchema,
  recordObservationCommandSchema,
  type CreateLearningCommand,
  type DecideExperimentCommand,
  type ExperimentDetailResource,
  type ExperimentLifecycleCommand,
  type ExperimentMutationResponse,
  type LearningMutationResponse,
  type MetricDefinitionResource,
  type ObservationMutationResponse,
  type RecordObservationCommand,
} from "@socrates/contracts";
import { Button, Panel } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormSelect,
  FormTextarea,
} from "@/components/forms/form-field";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

function Feedback({ error }: { error: string | null }) {
  return error ? (
    <p className="mt-3 text-xs leading-5 text-red-300" role="alert">
      {error}
    </p>
  ) : null;
}

function StartExperiment({
  experiment,
}: {
  experiment: ExperimentDetailResource;
}) {
  const router = useRouter();
  const command = useCommandSubmission<
    ExperimentLifecycleCommand,
    ExperimentMutationResponse
  >({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  return (
    <Panel className="flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
      <div>
        <h2 className="text-sm font-semibold">Ready to execute</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Starting freezes the execution timestamp and enables measurements.
        </p>
        <Feedback error={command.error} />
      </div>
      <Button
        disabled={command.pending}
        onClick={() => {
          const payload = experimentLifecycleCommandSchema.parse({
            expectedVersion: experiment.version,
          });
          command.submit(payload, (idempotencyKey) =>
            createBrowserControlPlaneClient().startExperiment(
              experiment.id,
              payload,
              idempotencyKey,
            ),
          );
        }}
        type="button"
        variant="primary"
      >
        <Play className="size-3.5" />
        {command.pending ? "Starting…" : "Start experiment"}
      </Button>
    </Panel>
  );
}

type ObservationTarget =
  | {
      kind: "before" | "after";
      id: string;
      label: string;
      unit: string;
      metricDefinitionId: string;
    }
  | {
      kind: "guardrail";
      id: string;
      label: string;
      unit: string;
      constraintDefinitionId: string;
    };

function ObservationForm({
  experiment,
  target,
}: {
  experiment: ExperimentDetailResource;
  target: ObservationTarget;
}) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const command = useCommandSubmission<
    RecordObservationCommand,
    ObservationMutationResponse
  >({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    command.clearError();
    const form = new FormData(event.currentTarget);
    const notes = String(form.get("notes") ?? "").trim();
    const base = {
      expectedVersion: experiment.version,
      kind: target.kind,
      value: {
        amount: String(form.get("amount") ?? ""),
        unit: target.unit,
      },
      sampleCount: Number(form.get("sampleCount")),
      ...(notes ? { notes } : {}),
    };
    const parsed = recordObservationCommandSchema.safeParse(
      target.kind === "guardrail"
        ? {
            ...base,
            constraintDefinitionId: target.constraintDefinitionId,
          }
        : { ...base, metricDefinitionId: target.metricDefinitionId },
    );

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

    command.submit(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().recordObservation(
        experiment.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <Panel className="p-4">
      <h2 className="text-sm font-semibold">{target.label}</h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        This observation is immutable after it is recorded.
      </p>
      <form className="mt-4 grid gap-4" noValidate onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            error={fieldErrors["value.amount"]}
            htmlFor={`${target.id}-amount`}
            label={`Value (${target.unit})`}
          >
            <FormInput
              id={`${target.id}-amount`}
              inputMode="decimal"
              name="amount"
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["sampleCount"]}
            htmlFor={`${target.id}-samples`}
            label="Samples"
          >
            <FormInput
              defaultValue="1"
              id={`${target.id}-samples`}
              min={1}
              name="sampleCount"
              required
              step={1}
              type="number"
            />
          </FormField>
        </div>
        <FormField
          error={fieldErrors["notes"]}
          htmlFor={`${target.id}-notes`}
          label="Notes"
        >
          <FormTextarea
            className="min-h-20"
            id={`${target.id}-notes`}
            maxLength={4_000}
            name="notes"
          />
        </FormField>
        <Feedback error={command.error} />
        <div className="flex justify-end">
          <Button disabled={command.pending} type="submit" variant="primary">
            {command.pending ? "Recording…" : `Record ${target.kind}`}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function DecideExperiment({
  experiment,
  ready,
}: {
  experiment: ExperimentDetailResource;
  ready: boolean;
}) {
  const router = useRouter();
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const command = useCommandSubmission<
    DecideExperimentCommand,
    ExperimentMutationResponse
  >({
    onSuccess: () => router.refresh(),
    onVersionConflict: () => router.refresh(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    command.clearError();
    const form = new FormData(event.currentTarget);
    const parsed = decideExperimentCommandSchema.safeParse({
      expectedVersion: experiment.version,
      ...(overrideEnabled
        ? {
            override: {
              decision: String(form.get("override.decision") ?? ""),
              reason: String(form.get("override.reason") ?? ""),
            },
          }
        : {}),
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

    command.submit(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().decideExperiment(
        experiment.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <Panel className="p-4">
      <form className="grid gap-4" noValidate onSubmit={submit}>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <h2 className="text-sm font-semibold">Apply decision policy</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {ready
                ? "Compare exact measurements, threshold, noise, and hard guardrails."
                : "Before, after, and every hard guardrail measurement are required."}
            </p>
          </div>
          <Button
            disabled={!ready || command.pending}
            type="submit"
            variant="primary"
          >
            {command.pending ? "Evaluating…" : "Decide experiment"}
          </Button>
        </div>
        <label className="flex items-start gap-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
          <input
            checked={overrideEnabled}
            className="mt-0.5 size-3.5 accent-white"
            onChange={(event) => {
              setOverrideEnabled(event.target.checked);
              setFieldErrors({});
              command.clearError();
            }}
            type="checkbox"
          />
          <span>
            Set a manual final decision
            <span className="mt-1 block text-[var(--text-subtle)]">
              The deterministic result is still evaluated and preserved.
            </span>
          </span>
        </label>
        {overrideEnabled ? (
          <div className="grid gap-4 border-l border-[var(--border-strong)] pl-4 sm:grid-cols-2">
            <FormField
              error={fieldErrors["override.decision"]}
              htmlFor="override.decision"
              label="Final decision"
            >
              <FormSelect
                defaultValue="discarded"
                id="override.decision"
                name="override.decision"
              >
                <option value="kept">Kept</option>
                <option value="discarded">Discarded</option>
                <option value="inconclusive">Inconclusive</option>
              </FormSelect>
            </FormField>
            <FormField
              error={fieldErrors["override.reason"]}
              htmlFor="override.reason"
              label="Override reason"
            >
              <FormTextarea
                id="override.reason"
                maxLength={2_000}
                name="override.reason"
                placeholder="Explain why accountable judgment differs from policy."
                required
              />
            </FormField>
          </div>
        ) : null}
        <Feedback error={command.error} />
      </form>
    </Panel>
  );
}

function LearningForm({
  experiment,
}: {
  experiment: ExperimentDetailResource;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const command = useCommandSubmission<
    CreateLearningCommand,
    LearningMutationResponse
  >({
    onSuccess: () => {
      formRef.current?.reset();
      router.refresh();
    },
    onVersionConflict: () => router.refresh(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    command.clearError();
    const form = new FormData(event.currentTarget);
    const parsed = createLearningCommandSchema.safeParse({
      expectedVersion: experiment.version,
      statement: String(form.get("statement") ?? ""),
      confidence: Number(form.get("confidence")),
      evidenceRole: String(form.get("evidenceRole") ?? ""),
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

    command.submit(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().createLearning(
        experiment.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <Panel className="p-4">
      <h2 className="text-sm font-semibold">Preserve a learning</h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Link a durable statement to this experiment’s evidence.
      </p>
      <form
        className="mt-4 grid gap-4"
        noValidate
        onSubmit={submit}
        ref={formRef}
      >
        <FormField
          error={fieldErrors["statement"]}
          htmlFor="learning-statement"
          label="Statement"
        >
          <FormTextarea
            id="learning-statement"
            maxLength={4_000}
            name="statement"
            required
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            error={fieldErrors["confidence"]}
            htmlFor="learning-confidence"
            label="Confidence"
          >
            <FormInput
              defaultValue="0.8"
              id="learning-confidence"
              max={1}
              min={0}
              name="confidence"
              required
              step="0.01"
              type="number"
            />
          </FormField>
          <FormField
            error={fieldErrors["evidenceRole"]}
            htmlFor="learning-role"
            label="Evidence role"
          >
            <FormSelect
              defaultValue="supports"
              id="learning-role"
              name="evidenceRole"
            >
              <option value="supports">Supports</option>
              <option value="contradicts">Contradicts</option>
            </FormSelect>
          </FormField>
        </div>
        <Feedback error={command.error} />
        <div className="flex justify-end">
          <Button disabled={command.pending} type="submit" variant="primary">
            {command.pending ? "Saving…" : "Save learning"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function ExperimentWorkflowControls({
  experiment,
  metricDefinition,
}: {
  experiment: ExperimentDetailResource;
  metricDefinition: MetricDefinitionResource;
}) {
  if (experiment.status === "proposed") {
    return <StartExperiment experiment={experiment} />;
  }

  const before = experiment.observations.find(
    (observation) => observation.kind === "before",
  );
  const after = experiment.observations.find(
    (observation) => observation.kind === "after",
  );
  const missingGuardrails = metricDefinition.guardrails.filter(
    (guardrail) =>
      !experiment.observations.some(
        (observation) => observation.constraintDefinitionId === guardrail.id,
      ),
  );

  if (experiment.status === "executing" && !before) {
    return (
      <ObservationForm
        experiment={experiment}
        target={{
          kind: "before",
          id: "before",
          label: "Record metric before",
          unit: metricDefinition.unit,
          metricDefinitionId: metricDefinition.id,
        }}
      />
    );
  }

  if (["executing", "measuring"].includes(experiment.status)) {
    const hardGuardrailsReady = metricDefinition.guardrails
      .filter(({ hard }) => hard)
      .every((guardrail) => !missingGuardrails.includes(guardrail));

    return (
      <div className="space-y-4">
        {!after ? (
          <ObservationForm
            experiment={experiment}
            target={{
              kind: "after",
              id: "after",
              label: "Record metric after",
              unit: metricDefinition.unit,
              metricDefinitionId: metricDefinition.id,
            }}
          />
        ) : null}
        {missingGuardrails.map((guardrail) => (
          <ObservationForm
            experiment={experiment}
            key={guardrail.id}
            target={{
              kind: "guardrail",
              id: guardrail.id,
              label: `Record guardrail · ${guardrail.name}`,
              unit: guardrail.unit,
              constraintDefinitionId: guardrail.id,
            }}
          />
        ))}
        {after ? (
          <DecideExperiment
            experiment={experiment}
            ready={Boolean(before && after && hardGuardrailsReady)}
          />
        ) : null}
      </div>
    );
  }

  if (["kept", "discarded", "inconclusive"].includes(experiment.status)) {
    return <LearningForm experiment={experiment} />;
  }

  return null;
}
