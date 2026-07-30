import { z } from "zod";

const canonicalDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.(?:\d*[1-9]))?$/;

export const entityIdSchema = z.uuid();

export const canonicalDecimalSchema = z
  .string()
  .regex(canonicalDecimalPattern, "Expected a canonical decimal string.")
  .refine((value) => value !== "-0", "Negative zero is not canonical.");

export const metricDirectionSchema = z.enum(["maximize", "minimize"]);
export type MetricDirection = z.infer<typeof metricDirectionSchema>;

export const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.min(1);

export const expectedVersionSchema = nonNegativeSafeIntegerSchema;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const metricValueSchema = z
  .object({
    amount: canonicalDecimalSchema,
    unit: z.string().trim().min(1).max(32),
  })
  .strict();
export type MetricValueContract = z.infer<typeof metricValueSchema>;

export const budgetLimitSchema = z
  .object({
    maximumExperiments: positiveSafeIntegerSchema,
    maximumDurationMs: positiveSafeIntegerSchema,
    maximumCostMinor: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type BudgetLimitContract = z.infer<typeof budgetLimitSchema>;
