"use client";

import { Plus, X } from "lucide-react";

import type {
  MetricDefinitionInput,
  MetricDefinitionResource,
} from "@socrates/contracts";
import { Button } from "@socrates/design-system";

import {
  FormField,
  FormInput,
  FormSelect,
} from "@/components/forms/form-field";

export type MetricFieldErrors = Record<string, string>;

export type GuardrailField = {
  key: number;
  value?: MetricDefinitionResource["guardrails"][number];
};

export function readMetricDefinitionFields(
  form: FormData,
  guardrails: readonly GuardrailField[],
) {
  return {
    name: String(form.get("metric.name") ?? ""),
    unit: String(form.get("metric.unit") ?? ""),
    direction: String(form.get("metric.direction") ?? ""),
    minimumImprovement: String(form.get("metric.minimumImprovement") ?? ""),
    noiseTolerance: String(form.get("metric.noiseTolerance") ?? ""),
    guardrails: guardrails.map(({ key }) => ({
      name: String(form.get(`guardrail.${key}.name`) ?? ""),
      unit: String(form.get(`guardrail.${key}.unit`) ?? ""),
      operator: String(form.get(`guardrail.${key}.operator`) ?? ""),
      threshold: String(form.get(`guardrail.${key}.threshold`) ?? ""),
      hard: form.get(`guardrail.${key}.hard`) === "on",
    })),
  };
}

export function MetricDefinitionFields({
  errors,
  guardrails,
  initialMetric,
  onAddGuardrail,
  onRemoveGuardrail,
}: {
  errors: MetricFieldErrors;
  guardrails: readonly GuardrailField[];
  initialMetric?: MetricDefinitionInput;
  onAddGuardrail: () => void;
  onRemoveGuardrail: (key: number) => void;
}) {
  return (
    <>
      <section>
        <div className="border-b border-[var(--border)] pb-3">
          <h2 className="text-sm font-semibold">Primary metric</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Decimal values use exact string arithmetic in the decision policy.
          </p>
        </div>
        <div className="grid gap-5 pt-5 sm:grid-cols-2">
          <FormField
            error={errors["metric.name"]}
            htmlFor="metric.name"
            label="Metric name"
          >
            <FormInput
              defaultValue={initialMetric?.name}
              id="metric.name"
              maxLength={120}
              name="metric.name"
              placeholder="Mobile LCP"
              required
            />
          </FormField>
          <FormField
            error={errors["metric.unit"]}
            htmlFor="metric.unit"
            label="Unit"
          >
            <FormInput
              defaultValue={initialMetric?.unit}
              id="metric.unit"
              maxLength={32}
              name="metric.unit"
              placeholder="s"
              required
            />
          </FormField>
          <FormField
            error={errors["metric.direction"]}
            htmlFor="metric.direction"
            label="Direction"
          >
            <FormSelect
              defaultValue={initialMetric?.direction ?? "minimize"}
              id="metric.direction"
              name="metric.direction"
            >
              <option value="minimize">Minimize</option>
              <option value="maximize">Maximize</option>
            </FormSelect>
          </FormField>
          <FormField
            error={errors["metric.minimumImprovement"]}
            htmlFor="metric.minimumImprovement"
            label="Minimum improvement"
          >
            <FormInput
              defaultValue={initialMetric?.minimumImprovement ?? "0"}
              id="metric.minimumImprovement"
              inputMode="decimal"
              name="metric.minimumImprovement"
              required
            />
          </FormField>
          <FormField
            description="Changes within this absolute tolerance are inconclusive."
            error={errors["metric.noiseTolerance"]}
            htmlFor="metric.noiseTolerance"
            label="Noise tolerance"
          >
            <FormInput
              defaultValue={initialMetric?.noiseTolerance ?? "0"}
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
            disabled={guardrails.length >= 20}
            onClick={onAddGuardrail}
            size="sm"
            type="button"
          >
            <Plus className="size-3.5" />
            Add guardrail
          </Button>
        </div>
        {guardrails.length > 0 ? (
          <div className="divide-y divide-[var(--border)]">
            {guardrails.map(({ key, value }, index) => {
              const errorPrefix = `metric.guardrails.${index}`;
              return (
                <div className="py-5" key={key}>
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                      Guardrail {index + 1}
                    </h3>
                    <Button
                      aria-label={`Remove guardrail ${index + 1}`}
                      onClick={() => onRemoveGuardrail(key)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      error={errors[`${errorPrefix}.name`]}
                      htmlFor={`${errorPrefix}.name`}
                      label="Name"
                    >
                      <FormInput
                        defaultValue={value?.name}
                        id={`${errorPrefix}.name`}
                        maxLength={120}
                        name={`guardrail.${key}.name`}
                        placeholder="Error rate"
                        required
                      />
                    </FormField>
                    <FormField
                      error={errors[`${errorPrefix}.unit`]}
                      htmlFor={`${errorPrefix}.unit`}
                      label="Unit"
                    >
                      <FormInput
                        defaultValue={value?.unit}
                        id={`${errorPrefix}.unit`}
                        maxLength={32}
                        name={`guardrail.${key}.unit`}
                        placeholder="%"
                        required
                      />
                    </FormField>
                    <FormField
                      error={errors[`${errorPrefix}.operator`]}
                      htmlFor={`${errorPrefix}.operator`}
                      label="Operator"
                    >
                      <FormSelect
                        defaultValue={value?.operator ?? "less_than_or_equal"}
                        id={`${errorPrefix}.operator`}
                        name={`guardrail.${key}.operator`}
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
                      error={errors[`${errorPrefix}.threshold`]}
                      htmlFor={`${errorPrefix}.threshold`}
                      label="Threshold"
                    >
                      <FormInput
                        defaultValue={value?.threshold}
                        id={`${errorPrefix}.threshold`}
                        inputMode="decimal"
                        name={`guardrail.${key}.threshold`}
                        required
                      />
                    </FormField>
                  </div>
                  <label className="mt-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <input
                      className="size-3.5 accent-white"
                      defaultChecked={value?.hard ?? true}
                      name={`guardrail.${key}.hard`}
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
    </>
  );
}
