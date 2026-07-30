import { z } from "zod";

import {
  canonicalDecimalSchema,
  entityIdSchema,
  expectedVersionSchema,
  metricDirectionSchema,
  nonNegativeCanonicalDecimalSchema,
} from "./common";
import { pageInfoSchema } from "./pagination";

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

export const guardrailDefinitionResourceSchema = guardrailDefinitionSchema
  .extend({
    id: entityIdSchema,
    metricDefinitionId: entityIdSchema,
  })
  .strict();

export const metricDefinitionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(32),
    direction: metricDirectionSchema,
    minimumImprovement: nonNegativeCanonicalDecimalSchema,
    noiseTolerance: nonNegativeCanonicalDecimalSchema,
    guardrails: z.array(guardrailDefinitionSchema).max(20).default([]),
  })
  .strict();
export type MetricDefinitionInput = z.infer<typeof metricDefinitionInputSchema>;

export const metricDefinitionResourceSchema = metricDefinitionInputSchema
  .extend({
    id: entityIdSchema,
    projectId: entityIdSchema,
    version: z.number().int().positive(),
    evaluatorConfig: z.record(z.string(), z.unknown()),
    guardrails: z.array(guardrailDefinitionResourceSchema),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MetricDefinitionResource = z.infer<
  typeof metricDefinitionResourceSchema
>;

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
    currentMetric: z
      .object({
        name: z.string(),
        unit: z.string(),
        direction: metricDirectionSchema,
      })
      .strict(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ProjectResource = z.infer<typeof projectResourceSchema>;

export const projectDetailResourceSchema = projectResourceSchema
  .extend({
    source: z
      .object({
        type: z.enum(["repository", "website", "dataset", "model", "other"]),
        reference: z.string(),
      })
      .strict()
      .nullable(),
    currentMetric: metricDefinitionResourceSchema,
  })
  .strict();
export type ProjectDetailResource = z.infer<typeof projectDetailResourceSchema>;

export const projectResponseSchema = z
  .object({ data: projectDetailResourceSchema })
  .strict();

export const projectListResponseSchema = z
  .object({
    data: z.array(projectResourceSchema),
    page: pageInfoSchema,
  })
  .strict();
