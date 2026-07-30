import { z } from "zod";

import {
  budgetLimitSchema,
  canonicalDecimalSchema,
  entityIdSchema,
  expectedVersionSchema,
  metricDirectionSchema,
  metricValueSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./common";
import { pageInfoSchema } from "./pagination";
import { learningResourceSchema } from "./learning";

export const experimentStatusSchema = z.enum([
  "proposed",
  "queued",
  "executing",
  "measuring",
  "evaluating",
  "failed",
  "kept",
  "discarded",
  "inconclusive",
]);
export type ExperimentStatusContract = z.infer<typeof experimentStatusSchema>;

export const experimentDecisionSchema = z.enum([
  "kept",
  "discarded",
  "inconclusive",
]);
export type ExperimentDecision = z.infer<typeof experimentDecisionSchema>;

export const proposeExperimentCommandSchema = z
  .object({
    expectedRunVersion: expectedVersionSchema,
    parentExperimentId: entityIdSchema.optional(),
    hypothesis: z.string().trim().min(1).max(4_000),
    action: z.string().trim().min(1).max(8_000),
    estimatedDurationMs: positiveSafeIntegerSchema,
    estimatedCostMinor: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type ProposeExperimentCommand = z.infer<
  typeof proposeExperimentCommandSchema
>;

export const experimentLifecycleCommandSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type ExperimentLifecycleCommand = z.infer<
  typeof experimentLifecycleCommandSchema
>;

const observationCommandBase = z.object({
  expectedVersion: expectedVersionSchema,
  value: metricValueSchema,
  sampleCount: positiveSafeIntegerSchema,
  notes: z.string().trim().max(4_000).optional(),
});

export const recordObservationCommandSchema = z.discriminatedUnion("kind", [
  observationCommandBase
    .extend({
      kind: z.enum(["before", "after"]),
      metricDefinitionId: entityIdSchema,
    })
    .strict(),
  observationCommandBase
    .extend({
      kind: z.literal("guardrail"),
      constraintDefinitionId: entityIdSchema,
    })
    .strict(),
]);
export type RecordObservationCommand = z.infer<
  typeof recordObservationCommandSchema
>;

export const decideExperimentCommandSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    override: z
      .object({
        decision: experimentDecisionSchema,
        reason: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DecideExperimentCommand = z.infer<
  typeof decideExperimentCommandSchema
>;

export const createLearningCommandSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    statement: z.string().trim().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
    evidenceRole: z.enum(["supports", "contradicts"]).default("supports"),
  })
  .strict();
export type CreateLearningCommand = z.infer<typeof createLearningCommandSchema>;

export const experimentResourceSchema = z
  .object({
    id: entityIdSchema,
    runId: entityIdSchema,
    parentExperimentId: entityIdSchema.nullable(),
    sequence: positiveSafeIntegerSchema,
    hypothesis: z.string(),
    action: z.string(),
    status: experimentStatusSchema,
    version: expectedVersionSchema,
    estimatedDurationMs: positiveSafeIntegerSchema,
    estimatedCostMinor: nonNegativeSafeIntegerSchema,
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ExperimentResource = z.infer<typeof experimentResourceSchema>;

export const experimentObservationResourceSchema = z
  .object({
    id: entityIdSchema,
    kind: z.enum(["before", "after", "guardrail"]),
    metricDefinitionId: entityIdSchema.nullable(),
    constraintDefinitionId: entityIdSchema.nullable(),
    value: metricValueSchema,
    sampleCount: positiveSafeIntegerSchema,
    notes: z.string().nullable(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export const experimentDecisionResourceSchema = z
  .object({
    id: entityIdSchema,
    policyVersion: z.string(),
    automatedDecision: experimentDecisionSchema,
    reason: z.enum([
      "improved",
      "within_noise",
      "below_threshold",
      "guardrail_failed",
      "invalid_measurement",
    ]),
    finalDecision: experimentDecisionSchema,
    overrideReason: z.string().nullable(),
    calculatedImprovement: canonicalDecimalSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export const experimentLearningResourceSchema = learningResourceSchema
  .extend({
    evidenceRole: z.enum(["supports", "contradicts"]),
  })
  .strict();

export const experimentDetailResourceSchema = experimentResourceSchema
  .extend({
    observations: z.array(experimentObservationResourceSchema),
    decision: experimentDecisionResourceSchema.nullable(),
    learnings: z.array(experimentLearningResourceSchema),
  })
  .strict();
export type ExperimentDetailResource = z.infer<
  typeof experimentDetailResourceSchema
>;

export const experimentResponseSchema = z
  .object({ data: experimentDetailResourceSchema })
  .strict();

export const experimentListResponseSchema = z
  .object({
    data: z.array(experimentDetailResourceSchema),
    page: pageInfoSchema,
  })
  .strict();

export const experimentTaskV1Schema = z
  .object({
    version: z.literal("1"),
    runId: entityIdSchema,
    experimentId: entityIdSchema,
    hypothesis: z.string().min(1),
    actionPlan: z
      .object({
        summary: z.string().min(1),
        capabilities: z.array(z.string()).default([]),
      })
      .strict(),
    metric: z
      .object({
        definitionId: entityIdSchema,
        direction: metricDirectionSchema,
        minimumImprovement: canonicalDecimalSchema,
      })
      .strict(),
    budget: budgetLimitSchema,
  })
  .strict();
export type ExperimentTaskV1 = z.infer<typeof experimentTaskV1Schema>;
