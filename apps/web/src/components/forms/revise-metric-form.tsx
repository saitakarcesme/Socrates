"use client";

import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";

import {
  createMetricDefinitionCommandSchema,
  type CreateMetricDefinitionCommand,
  type ProjectDetailResource,
  type ProjectMutationResponse,
} from "@socrates/contracts";
import { Button, buttonClassName } from "@socrates/design-system";

import {
  type GuardrailField,
  MetricDefinitionFields,
  type MetricFieldErrors,
  readMetricDefinitionFields,
} from "@/components/forms/metric-definition-fields";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

function focusFirstError(errors: MetricFieldErrors) {
  const first = Object.keys(errors)[0];
  if (first) document.getElementById(first)?.focus();
}

export function ReviseMetricForm({
  project,
}: {
  project: ProjectDetailResource;
}) {
  const router = useRouter();
  const nextGuardrailKey = useRef(project.currentMetric.guardrails.length + 1);
  const [guardrails, setGuardrails] = useState<GuardrailField[]>(
    project.currentMetric.guardrails.map((value, index) => ({
      key: index + 1,
      value,
    })),
  );
  const [fieldErrors, setFieldErrors] = useState<MetricFieldErrors>({});
  const [confirmation, setConfirmation] = useState(false);
  const command = useCommandSubmission<
    CreateMetricDefinitionCommand,
    ProjectMutationResponse
  >({
    onSuccess: () => router.push(`/projects/${project.id}`),
    onVersionConflict: () => router.refresh(),
  });

  function resetFeedback() {
    setConfirmation(false);
    setFieldErrors({});
    command.clearError();
  }

  function addGuardrail() {
    const key = nextGuardrailKey.current++;
    setGuardrails((current) => [...current, { key }]);
    resetFeedback();
  }

  function removeGuardrail(key: number) {
    setGuardrails((current) =>
      current.filter((candidate) => candidate.key !== key),
    );
    resetFeedback();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    command.clearError();

    const form = new FormData(event.currentTarget);
    const candidate = {
      expectedProjectVersion: project.version,
      metric: readMetricDefinitionFields(form, guardrails),
    };
    const parsed = createMetricDefinitionCommandSchema.safeParse(candidate);

    if (!parsed.success) {
      const errors = parsed.error.issues.reduce<MetricFieldErrors>(
        (result, issue) => {
          const field = issue.path.join(".");
          if (field && !result[field]) result[field] = issue.message;
          return result;
        },
        {},
      );
      setFieldErrors(errors);
      setConfirmation(false);
      requestAnimationFrame(() => focusFirstError(errors));
      return;
    }

    if (!confirmation) {
      setConfirmation(true);
      return;
    }

    command.submit(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().addMetricDefinition(
        project.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <form
      className="space-y-8"
      noValidate
      onChange={() => confirmation && setConfirmation(false)}
      onSubmit={submit}
    >
      <MetricDefinitionFields
        errors={fieldErrors}
        guardrails={guardrails}
        initialMetric={project.currentMetric}
        onAddGuardrail={addGuardrail}
        onRemoveGuardrail={removeGuardrail}
      />

      {confirmation ? (
        <div className="flex gap-3 rounded-[4px] border border-amber-900/70 bg-amber-950/20 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div>
            <p className="text-xs font-medium text-amber-200">
              Confirm protocol v{project.currentMetric.version + 1}
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-200/70">
              Existing runs remain frozen on their current protocol. Every new
              run will use this complete definition.
            </p>
          </div>
        </div>
      ) : null}

      {command.error ? (
        <div
          className="rounded-[4px] border border-red-950 bg-red-950/20 px-3 py-2.5 text-xs leading-5 text-red-300"
          role="alert"
        >
          {command.error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-5">
        <Link className={buttonClassName()} href={`/projects/${project.id}`}>
          Cancel
        </Link>
        <Button disabled={command.pending} type="submit" variant="primary">
          {command.pending
            ? "Creating…"
            : confirmation
              ? "Confirm revision"
              : "Review revision"}
          {!command.pending ? <ArrowRight className="size-3.5" /> : null}
        </Button>
      </div>
    </form>
  );
}
