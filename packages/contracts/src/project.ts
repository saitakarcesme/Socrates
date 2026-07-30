import { z } from "zod";

import {
  canonicalDecimalSchema,
  entityIdSchema,
  expectedVersionSchema,
  metricDirectionSchema,
} from "./common";

export const projectStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "archived",
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const guardrailDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(32),
    operator: z.enum([
      "less_than",
      "less_than_or_equal",
      "greater_than",
      "greater_than_or_equal",
    ]),
    threshold: canonicalDecimalSchema,
    hard: z.boolean(),
  })
  .strict();

export const metricDefinitionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(32),
    direction: metricDirectionSchema,
    minimumImprovement: canonicalDecimalSchema,
    noiseTolerance: canonicalDecimalSchema,
    guardrails: z.array(guardrailDefinitionSchema).max(20).default([]),
  })
  .strict();
export type MetricDefinitionInput = z.infer<typeof metricDefinitionInputSchema>;

export const createProjectCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(2_000),
    source: z
      .object({
        type: z.enum(["repository", "website", "dataset", "model", "other"]),
        reference: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .optional(),
    metric: metricDefinitionInputSchema,
  })
  .strict();
export type CreateProjectCommand = z.infer<typeof createProjectCommandSchema>;

export const createMetricDefinitionCommandSchema = z
  .object({
    expectedProjectVersion: expectedVersionSchema,
    metric: metricDefinitionInputSchema,
  })
  .strict();
export type CreateMetricDefinitionCommand = z.infer<
  typeof createMetricDefinitionCommandSchema
>;

export const projectResourceSchema = z
  .object({
    id: entityIdSchema,
    workspaceId: entityIdSchema,
    slug: z.string(),
    name: z.string(),
    objective: z.string(),
    status: projectStatusSchema,
    version: expectedVersionSchema,
    currentMetricDefinitionId: entityIdSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ProjectResource = z.infer<typeof projectResourceSchema>;
