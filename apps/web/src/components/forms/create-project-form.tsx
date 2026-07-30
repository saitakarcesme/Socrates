"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";

import { createProjectCommandSchema } from "@socrates/contracts";
import { Button, buttonClassName } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormSelect,
  FormTextarea,
} from "@/components/forms/form-field";
import { ControlPlaneContractError, ControlPlaneError } from "@/lib/api/client";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import {
  idempotencyKeyFor,
  type IdempotencyKeyState,
} from "@/lib/api/idempotency";

type FieldErrors = Record<string, string>;

function focusFirstError(errors: FieldErrors) {
  const first = Object.keys(errors)[0];
  if (first) {
    document.getElementById(first)?.focus();
  }
}

export function CreateProjectForm() {
  const router = useRouter();
  const idempotency = useRef<IdempotencyKeyState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

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
        guardrails: [],
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

    const submission = idempotencyKeyFor(parsed.data, idempotency.current);
    idempotency.current = submission;

    startTransition(async () => {
      try {
        const response = await createBrowserControlPlaneClient().createProject(
          parsed.data,
          submission.key,
        );
        idempotency.current = null;
        router.push(`/projects/${response.data.projectId}`);
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          setFormError(error.message);
          return;
        }
        if (error instanceof ControlPlaneContractError) {
          setFormError(
            "The control plane returned an unexpected response. Your input is preserved.",
          );
          return;
        }
        setFormError(
          "The control plane could not be reached. Retry to safely replay this submission.",
        );
      }
    });
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
