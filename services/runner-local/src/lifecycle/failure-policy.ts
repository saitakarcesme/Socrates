import {
  runnerBudgetDimensionSchema,
  runnerCancellationV1Schema,
} from "@socrates/contracts";
import { z } from "zod";

import { runnerEventDraft, type RunnerEventDraft } from "./draft";

type RunnerBudgetDimension = z.infer<typeof runnerBudgetDimensionSchema>;

const localFailureCodeSchema = z.enum([
  "projection_rejected",
  "source_unavailable",
  "source_invalid",
  "image_rejected",
  "source_materialization_failed",
  "request_materialization_failed",
  "sandbox_backend_failed",
  "runtime_protocol_invalid",
  "cleanup_failed",
  "unexpected_runner_failure",
]);
export type LocalFailureCode = z.infer<typeof localFailureCodeSchema>;

const ambiguityBoundarySchema = z.enum([
  "transport",
  "event_rejection",
  "spool",
  "acknowledgement",
  "work_journal",
  "completion",
]);
export type LocalFailureAmbiguityBoundary = z.infer<
  typeof ambiguityBoundarySchema
>;

const elapsedDurationSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const localFailureEvidenceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("failure"),
      code: localFailureCodeSchema,
      executionStarted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("budget"),
      dimension: runnerBudgetDimensionSchema,
      executionStarted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancellation"),
      directive: runnerCancellationV1Schema,
      executionStarted: z.boolean(),
      elapsedMs: elapsedDurationSchema,
      forced: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ambiguous"),
      boundary: ambiguityBoundarySchema,
      executionStarted: z.boolean(),
    })
    .strict(),
]);
export type LocalFailureEvidenceInput = z.infer<
  typeof localFailureEvidenceInputSchema
>;

export type LocalFailureEvidenceDecision =
  | Readonly<{ state: "evidence"; draft: RunnerEventDraft }>
  | Readonly<{
      state: "no_evidence";
      boundary: LocalFailureAmbiguityBoundary;
    }>;

const failurePolicy = {
  projection_rejected: {
    classification: "policy",
    message: "The frozen task cannot be represented by local runner policy.",
  },
  source_unavailable: {
    classification: "infrastructure",
    message: "The frozen source snapshot is unavailable to the runner.",
  },
  source_invalid: {
    classification: "policy",
    message: "The resolved source does not match the frozen task identity.",
  },
  image_rejected: {
    classification: "infrastructure",
    message: "The frozen sandbox image was not admitted by the runner.",
  },
  source_materialization_failed: {
    classification: "infrastructure",
    message: "The runner could not materialize the frozen source snapshot.",
  },
  request_materialization_failed: {
    classification: "infrastructure",
    message: "The runner could not materialize the bounded runtime request.",
  },
  sandbox_backend_failed: {
    classification: "infrastructure",
    message: "The isolated sandbox backend failed to execute the attempt.",
  },
  runtime_protocol_invalid: {
    classification: "infrastructure",
    message: "The task runtime returned invalid protocol evidence.",
  },
  cleanup_failed: {
    classification: "infrastructure",
    message: "The runner could not prove complete attempt resource cleanup.",
  },
  unexpected_runner_failure: {
    classification: "infrastructure",
    message: "The runner encountered an unexpected controlled failure.",
  },
} as const satisfies Record<
  LocalFailureCode,
  { classification: "infrastructure" | "policy"; message: string }
>;

function budgetMessage(dimension: RunnerBudgetDimension): string {
  return `The attempt exceeded its frozen ${dimension.replaceAll("_", " ")} budget.`;
}

export function localFailureEvidence(
  candidate: LocalFailureEvidenceInput,
): LocalFailureEvidenceDecision {
  const input = localFailureEvidenceInputSchema.parse(candidate);
  if (input.kind === "ambiguous") {
    return Object.freeze({
      state: "no_evidence",
      boundary: input.boundary,
    });
  }
  if (input.kind === "cancellation") {
    return Object.freeze({
      state: "evidence",
      draft: runnerEventDraft({
        type: "task.cancelled",
        payload: { forced: input.forced, durationMs: input.elapsedMs },
      }),
    });
  }
  if (input.kind === "budget") {
    return Object.freeze({
      state: "evidence",
      draft: runnerEventDraft({
        type: "task.failed",
        payload: {
          classification: "budget",
          budgetDimension: input.dimension,
          message: budgetMessage(input.dimension),
        },
      }),
    });
  }
  return Object.freeze({
    state: "evidence",
    draft: runnerEventDraft({
      type: "task.failed",
      payload: failurePolicy[input.code],
    }),
  });
}
