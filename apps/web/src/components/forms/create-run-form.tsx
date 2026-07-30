"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import {
  createRunCommandSchema,
  type CreateRunCommand,
  type ProjectDetailResource,
  type RunMutationResponse,
} from "@socrates/contracts";
import { Button, buttonClassName } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormTextarea,
} from "@/components/forms/form-field";
import { createBrowserControlPlaneClient } from "@/lib/api/browser";
import { useCommandSubmission } from "@/lib/api/use-command-submission";

type FieldErrors = Record<string, string>;

export function CreateRunForm({ project }: { project: ProjectDetailResource }) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const {
    clearError,
    error: formError,
    pending,
    submit: submitCommand,
  } = useCommandSubmission<CreateRunCommand, RunMutationResponse>({
    onSuccess: (response) =>
      router.push(`/projects/${project.id}/runs/${response.data.runId}`),
    onVersionConflict: () => router.refresh(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    clearError();

    const form = new FormData(event.currentTarget);
    const candidate = {
      expectedProjectVersion: project.version,
      title: String(form.get("title") ?? ""),
      objective: String(form.get("objective") ?? ""),
      metricDefinitionId: project.currentMetric.id,
      budget: {
        maximumExperiments: Number(form.get("maximumExperiments")),
        maximumDurationMs: Number(form.get("maximumDurationMinutes")) * 60_000,
        maximumCostMinor: Number(form.get("maximumCostMinor")),
      },
    };
    const parsed = createRunCommandSchema.safeParse(candidate);

    if (!parsed.success) {
      const errors = parsed.error.issues.reduce<FieldErrors>(
        (result, issue) => {
          const field = issue.path.join(".");
          if (field && !result[field]) result[field] = issue.message;
          return result;
        },
        {},
      );
      setFieldErrors(errors);
      const first = Object.keys(errors)[0];
      if (first) {
        requestAnimationFrame(() => document.getElementById(first)?.focus());
      }
      return;
    }

    submitCommand(parsed.data, (idempotencyKey) =>
      createBrowserControlPlaneClient().createRun(
        project.id,
        parsed.data,
        idempotencyKey,
      ),
    );
  }

  return (
    <form className="space-y-8" noValidate onSubmit={submit}>
      <section>
        <div className="border-b border-[var(--border)] pb-3">
          <h2 className="text-sm font-semibold">Research session</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            The run is created as a draft against metric protocol v
            {project.currentMetric.version}.
          </p>
        </div>
        <div className="grid gap-5 pt-5">
          <FormField error={fieldErrors["title"]} htmlFor="title" label="Title">
            <FormInput
              autoComplete="off"
              id="title"
              maxLength={160}
              name="title"
              placeholder="Improve initial mobile render"
              required
            />
          </FormField>
          <FormField
            error={fieldErrors["objective"]}
            htmlFor="objective"
            label="Run objective"
          >
            <FormTextarea
              defaultValue={project.objective}
              id="objective"
              maxLength={2_000}
              name="objective"
              required
            />
          </FormField>
        </div>
      </section>

      <section>
        <div className="border-b border-[var(--border)] pb-3">
          <h2 className="text-sm font-semibold">Hard budget</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Commands stop when any limit is exhausted.
          </p>
        </div>
        <div className="grid gap-5 pt-5 sm:grid-cols-3">
          <FormField
            error={fieldErrors["budget.maximumExperiments"]}
            htmlFor="budget.maximumExperiments"
            label="Experiments"
          >
            <FormInput
              defaultValue="10"
              id="budget.maximumExperiments"
              min={1}
              name="maximumExperiments"
              required
              step={1}
              type="number"
            />
          </FormField>
          <FormField
            error={fieldErrors["budget.maximumDurationMs"]}
            htmlFor="budget.maximumDurationMs"
            label="Duration (minutes)"
          >
            <FormInput
              defaultValue="60"
              id="budget.maximumDurationMs"
              min={1}
              name="maximumDurationMinutes"
              required
              step={1}
              type="number"
            />
          </FormField>
          <FormField
            description="Integer accounting units; zero disables spend."
            error={fieldErrors["budget.maximumCostMinor"]}
            htmlFor="budget.maximumCostMinor"
            label="Cost (minor units)"
          >
            <FormInput
              defaultValue="0"
              id="budget.maximumCostMinor"
              min={0}
              name="maximumCostMinor"
              required
              step={1}
              type="number"
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
        <Link className={buttonClassName()} href={`/projects/${project.id}`}>
          Cancel
        </Link>
        <Button disabled={pending} type="submit" variant="primary">
          {pending ? "Creating…" : "Create draft run"}
          {!pending ? <ArrowRight className="size-3.5" /> : null}
        </Button>
      </div>
    </form>
  );
}
