"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";

import {
  createProjectCommandSchema,
  type CreateProjectCommand,
  type ProjectMutationResponse,
} from "@socrates/contracts";
import { Button, buttonClassName } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormSelect,
  FormTextarea,
} from "@/components/forms/form-field";
import {
  type GuardrailField,
  MetricDefinitionFields,
  readMetricDefinitionFields,
} from "@/components/forms/metric-definition-fields";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

type FieldErrors = Record<string, string>;

function focusFirstError(errors: FieldErrors) {
  const first = Object.keys(errors)[0];
  if (first) {
    document.getElementById(first)?.focus();
  }
}

export function CreateProjectForm() {
  const router = useRouter();
  const nextGuardrailId = useRef(1);
  const [guardrails, setGuardrails] = useState<GuardrailField[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const {
    clearError,
    error: formError,
    pending,
    submit: submitCommand,
  } = useCommandSubmission<CreateProjectCommand, ProjectMutationResponse>({
    onSuccess: (response) =>
      router.push(`/projects/${response.data.projectId}`),
  });

  function addGuardrail() {
    const key = nextGuardrailId.current++;
    setGuardrails((current) => [...current, { key }]);
    setFieldErrors({});
    clearError();
  }

  function removeGuardrail(key: number) {
    setGuardrails((current) =>
      current.filter((candidate) => candidate.key !== key),
    );
    setFieldErrors({});
    clearError();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    clearError();

    const form = new FormData(event.currentTarget);
    const sourceReference = String(form.get("source.reference") ?? "").trim();
    const candidate = {
      name: String(form.get("name") ?? ""),
      objective: String(form.get("objective") ?? ""),
      ...(sourceReference
        ? {
            source: {
              type: String(form.get("source.type") ?? "repository"),
              reference: sourceReference,
            },
          }
        : {}),
      metric: readMetricDefinitionFields(form, guardrails),
    };
    const parsed = createProjectCommandSchema.safeParse(candidate);

    if (!parsed.success) {
      const errors = parsed.error.issues.reduce<FieldErrors>(
        (result, issue) => {
          const field = issue.path.join(".");
          if (field && !result[field]) {
            result[field] = issue.message;
          }
          return result;
        },
        {},
      );
      setFieldErrors(errors);
      requestAnimationFrame(() => focusFirstError(errors));
      return;
    }

    submitCommand(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().createProject(
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <form className="space-y-8" noValidate onSubmit={submit}>
      <section>
        <div className="border-b border-[var(--border)] pb-3">
          <h2 className="text-sm font-semibold">Objective</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Define one bounded optimization target.
          </p>
        </div>
        <div className="grid gap-5 pt-5">
          <FormField error={fieldErrors["name"]} htmlFor="name" label="Name">
            <FormInput
              aria-describedby={fieldErrors["name"] ? "name-error" : undefined}
              autoComplete="off"
              id="name"
              maxLength={120}
              name="name"
              placeholder="Atlas web performance"
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["objective"]}
            htmlFor="objective"
            label="Objective"
          >
            <FormTextarea
              aria-describedby={
                fieldErrors["objective"] ? "objective-error" : undefined
              }
              id="objective"
              maxLength={2_000}
              name="objective"
              placeholder="Reduce mobile LCP while preserving visual stability."
              required
            />
          </FormField>
          <div className="grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
            <FormField htmlFor="source.type" label="Source type">
              <FormSelect
                defaultValue="repository"
                id="source.type"
                name="source.type"
              >
                <option value="repository">Repository</option>
                <option value="website">Website</option>
                <option value="dataset">Dataset</option>
                <option value="model">Model</option>
                <option value="other">Other</option>
              </FormSelect>
            </FormField>
            <FormField
              description="Optional descriptive reference. Socrates does not access it yet."
              error={fieldErrors["source.reference"]}
              htmlFor="source.reference"
              label="Source reference"
            >
              <FormInput
                aria-describedby={
                  fieldErrors["source.reference"]
                    ? "source.reference-error"
                    : "source.reference-description"
                }
                id="source.reference"
                maxLength={2_000}
                name="source.reference"
                placeholder="https://github.com/acme/atlas"
              />
            </FormField>
          </div>
        </div>
      </section>

      <MetricDefinitionFields
        errors={fieldErrors}
        guardrails={guardrails}
        onAddGuardrail={addGuardrail}
        onRemoveGuardrail={removeGuardrail}
      />

      {formError ? (
        <div
          className="rounded-[4px] border border-red-950 bg-red-950/20 px-3 py-2.5 text-xs leading-5 text-red-300"
          role="alert"
        >
          {formError}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-5">
        <Link className={buttonClassName()} href="/projects">
          Cancel
        </Link>
        <Button disabled={pending} type="submit" variant="primary">
          {pending ? "Creating…" : "Create project"}
          {!pending ? <ArrowRight className="size-3.5" /> : null}
        </Button>
      </div>
    </form>
  );
}
