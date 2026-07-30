import { z } from "zod";

import {
  entityIdSchema,
  expectedVersionSchema,
  idempotencyKeySchema,
} from "./common";
import { experimentStatusSchema } from "./experiment";
import { runStatusSchema } from "./run";

export const idempotencyHeaderSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});

export const projectMutationResourceSchema = z
  .object({
    projectId: entityIdSchema,
    projectVersion: expectedVersionSchema,
    currentMetricDefinitionId: entityIdSchema,
    guardrails: z.array(
      z
        .object({
          constraintDefinitionId: entityIdSchema,
          name: z.string(),
          unit: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const projectMutationResponseSchema = z
  .object({ data: projectMutationResourceSchema })
  .strict();
export type ProjectMutationResponse = z.infer<
  typeof projectMutationResponseSchema
>;

export const runMutationResourceSchema = z
  .object({
    runId: entityIdSchema,
    projectId: entityIdSchema,
    version: expectedVersionSchema,
    status: runStatusSchema,
  })
  .strict();

export const runMutationResponseSchema = z
  .object({ data: runMutationResourceSchema })
  .strict();
export type RunMutationResponse = z.infer<typeof runMutationResponseSchema>;

export const experimentMutationResourceSchema = z
  .object({
    experimentId: entityIdSchema,
    runId: entityIdSchema,
    version: expectedVersionSchema,
    status: experimentStatusSchema,
  })
  .strict();

export const experimentMutationResponseSchema = z
  .object({ data: experimentMutationResourceSchema })
  .strict();
export type ExperimentMutationResponse = z.infer<
  typeof experimentMutationResponseSchema
>;

export const observationMutationResponseSchema = z
  .object({
    data: z
      .object({
        observationId: entityIdSchema,
        experimentId: entityIdSchema,
        version: expectedVersionSchema,
        status: experimentStatusSchema,
      })
      .strict(),
  })
  .strict();
export type ObservationMutationResponse = z.infer<
  typeof observationMutationResponseSchema
>;

export const learningMutationResponseSchema = z
  .object({
    data: z
      .object({
        learningId: entityIdSchema,
        experimentId: entityIdSchema,
        version: expectedVersionSchema,
      })
      .strict(),
  })
  .strict();
export type LearningMutationResponse = z.infer<
  typeof learningMutationResponseSchema
>;
