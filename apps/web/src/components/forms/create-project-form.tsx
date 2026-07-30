"use client";

import { ArrowRight, Plus, X } from "lucide-react";
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
  const [guardrailIds, setGuardrailIds] = useState<number[]>([]);
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
    const id = nextGuardrailId.current++;
    setGuardrailIds((current) => [...current, id]);
    setFieldErrors({});
    clearError();
  }

  function removeGuardrail(id: number) {
    setGuardrailIds((current) =>
      current.filter((candidate) => candidate !== id),
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
      metric: {
        name: String(form.get("metric.name") ?? ""),
        unit: String(form.get("metric.unit") ?? ""),
        direction: String(form.get("metric.direction") ?? ""),
        minimumImprovement: String(form.get("metric.minimumImprovement") ?? ""),
        noiseTolerance: String(form.get("metric.noiseTolerance") ?? ""),
        guardrails: guardrailIds.map((id) => ({
          name: String(form.get(`guardrail.${id}.name`) ?? ""),
          unit: String(form.get(`guardrail.${id}.unit`) ?? ""),
          operator: String(form.get(`guardrail.${id}.operator`) ?? ""),
          threshold: String(form.get(`guardrail.${id}.threshold`) ?? ""),
          hard: form.get(`guardrail.${id}.hard`) === "on",
        })),
      },
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

      <section>
        <div className="border-b border-[var(--border)] pb-3">
          <h2 className="text-sm font-semibold">Primary metric</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Decimal values use exact string arithmetic in the decision policy.
          </p>
        </div>
        <div className="grid gap-5 pt-5 sm:grid-cols-2">
          <FormField
            error={fieldErrors["metric.name"]}
            htmlFor="metric.name"
            label="Metric name"
          >
            <FormInput
              id="metric.name"
              maxLength={120}
              name="metric.name"
              placeholder="Mobile LCP"
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["metric.unit"]}
            htmlFor="metric.unit"
            label="Unit"
          >
            <FormInput
              id="metric.unit"
              maxLength={32}
              name="metric.unit"
              placeholder="s"
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["metric.direction"]}
            htmlFor="metric.direction"
            label="Direction"
          >
            <FormSelect
              defaultValue="minimize"
              id="metric.direction"
              name="metric.direction"
            >
              <option value="minimize">Minimize</option>
              <option value="maximize">Maximize</option>
            </FormSelect>
          </FormField>
          <FormField
            error={fieldErrors["metric.minimumImprovement"]}
            htmlFor="metric.minimumImprovement"
            label="Minimum improvement"
          >
            <FormInput
              defaultValue="0"
              id="metric.minimumImprovement"
              inputMode="decimal"
              name="metric.minimumImprovement"
              required
            />
          </FormField>
          <FormField
            description="Changes within this absolute tolerance are inconclusive."
            error={fieldErrors["metric.noiseTolerance"]}
            htmlFor="metric.noiseTolerance"
            label="Noise tolerance"
          >
            <FormInput
              defaultValue="0"
              id="metric.noiseTolerance"
              inputMode="decimal"
              name="metric.noiseTolerance"
              required
            />
          </FormField>
        </div>
      </section>

      <section>
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] pb-3">
          <div>
            <h2 className="text-sm font-semibold">Guardrails</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Optional constraints measured alongside the primary metric.
            </p>
          </div>
          <Button
            disabled={guardrailIds.length >= 20}
            onClick={addGuardrail}
            size="sm"
            type="button"
          >
            <Plus className="size-3.5" />
            Add guardrail
          </Button>
        </div>
        {guardrailIds.length > 0 ? (
          <div className="divide-y divide-[var(--border)]">
            {guardrailIds.map((id, index) => {
              const errorPrefix = `metric.guardrails.${index}`;
              return (
                <div className="py-5" key={id}>
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                      Guardrail {index + 1}
                    </h3>
                    <Button
                      aria-label={`Remove guardrail ${index + 1}`}
                      onClick={() => removeGuardrail(id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      error={fieldErrors[`${errorPrefix}.name`]}
                      htmlFor={`guardrail.${id}.name`}
                      label="Name"
                    >
                      <FormInput
                        id={`guardrail.${id}.name`}
                        maxLength={120}
                        name={`guardrail.${id}.name`}
                        placeholder="Error rate"
                        required
                      />
                    </FormField>
                    <FormField
                      error={fieldErrors[`${errorPrefix}.unit`]}
                      htmlFor={`guardrail.${id}.unit`}
                      label="Unit"
                    >
                      <FormInput
                        id={`guardrail.${id}.unit`}
                        maxLength={32}
                        name={`guardrail.${id}.unit`}
                        placeholder="%"
                        required
                      />
                    </FormField>
                    <FormField
                      error={fieldErrors[`${errorPrefix}.operator`]}
                      htmlFor={`guardrail.${id}.operator`}
                      label="Operator"
                    >
                      <FormSelect
                        defaultValue="less_than_or_equal"
                        id={`guardrail.${id}.operator`}
                        name={`guardrail.${id}.operator`}
                      >
                        <option value="less_than">Less than</option>
                        <option value="less_than_or_equal">
                          Less than or equal
                        </option>
                        <option value="greater_than">Greater than</option>
                        <option value="greater_than_or_equal">
                          Greater than or equal
                        </option>
                      </FormSelect>
                    </FormField>
                    <FormField
                      error={fieldErrors[`${errorPrefix}.threshold`]}
                      htmlFor={`guardrail.${id}.threshold`}
                      label="Threshold"
                    >
                      <FormInput
                        id={`guardrail.${id}.threshold`}
                        inputMode="decimal"
                        name={`guardrail.${id}.threshold`}
                        required
                      />
                    </FormField>
                  </div>
                  <label className="mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <input
                      className="size-3.5 accent-white"
                      defaultChecked
                      name={`guardrail.${id}.hard`}
                      type="checkbox"
                    />
                    Hard guardrail — a failed or missing measurement prevents a
                    kept decision.
                  </label>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="pt-4 text-xs text-[var(--text-subtle)]">
            No guardrails. The decision will use only the primary metric.
          </p>
        )}
      </section>

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
