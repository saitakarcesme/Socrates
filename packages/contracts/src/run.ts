import { z } from "zod";

import {
  budgetLimitSchema,
  entityIdSchema,
  expectedVersionSchema,
  metricValueSchema,
  positiveSafeIntegerSchema,
} from "./common";

export const runStatusSchema = z.enum([
  "draft",
  "queued",
  "preparing",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "budget_exhausted",
]);
export type RunStatusContract = z.infer<typeof runStatusSchema>;

export const createRunCommandSchema = z
  .object({
    expectedProjectVersion: expectedVersionSchema,
    title: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(2_000),
    metricDefinitionId: entityIdSchema,
    budget: budgetLimitSchema,
  })
  .strict();
export type CreateRunCommand = z.infer<typeof createRunCommandSchema>;

export const recordBaselineCommandSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    value: metricValueSchema,
    sampleCount: positiveSafeIntegerSchema,
    notes: z.string().trim().max(4_000).optional(),
  })
  .strict();
export type RecordBaselineCommand = z.infer<typeof recordBaselineCommandSchema>;

export const runLifecycleCommandSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type RunLifecycleCommand = z.infer<typeof runLifecycleCommandSchema>;

export const runResourceSchema = z
  .object({
    id: entityIdSchema,
    projectId: entityIdSchema,
    metricDefinitionId: entityIdSchema,
    sequence: positiveSafeIntegerSchema,
    title: z.string(),
    objective: z.string(),
    status: runStatusSchema,
    version: expectedVersionSchema,
    budget: budgetLimitSchema,
    baseline: metricValueSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type RunResource = z.infer<typeof runResourceSchema>;
