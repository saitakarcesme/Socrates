import { z } from "zod";

import {
  canonicalDecimalSchema,
  entityIdSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./common";
import { eventPageInfoSchema } from "./pagination";
import { sha256DigestSchema } from "./runner";

/**
 * Historical Phase 0 wire fixture. V1 events are parseable for compatibility
 * but are not accepted by an executable runner claim.
 */
const runnerEventEnvelopeSchema = z.object({
  version: z.literal("1"),
  eventId: entityIdSchema,
  taskId: entityIdSchema,
  sequence: nonNegativeSafeIntegerSchema,
  occurredAt: z.iso.datetime(),
});

export const runnerEventV1Schema = z.discriminatedUnion("type", [
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.accepted"),
    payload: z.object({ runnerId: entityIdSchema }).strict(),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("log.appended"),
    payload: z
      .object({
        stream: z.enum(["stdout", "stderr", "system"]),
        text: z.string(),
      })
      .strict(),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("measurement.recorded"),
    payload: z
      .object({
        metricDefinitionId: entityIdSchema,
        amount: canonicalDecimalSchema,
        unit: z.string().min(1),
      })
      .strict(),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.succeeded"),
    payload: z.object({ exitCode: z.literal(0) }).strict(),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.failed"),
    payload: z
      .object({
        classification: z.enum([
          "infrastructure",
          "invalid_action",
          "evaluation",
          "budget",
          "policy",
        ]),
        message: z.string(),
      })
      .strict(),
  }),
]);
export type RunnerEventV1 = z.infer<typeof runnerEventV1Schema>;

const runnerEventV2EnvelopeSchema = z.object({
  version: z.literal("2"),
  eventId: entityIdSchema,
  runnerId: entityIdSchema,
  taskId: entityIdSchema,
  attemptId: entityIdSchema,
  fence: positiveSafeIntegerSchema,
  sequence: positiveSafeIntegerSchema,
  occurredAt: z.iso.datetime(),
});

export const runnerFailureClassificationSchema = z.enum([
  "infrastructure",
  "invalid_action",
  "evaluation",
  "budget",
  "policy",
]);

export const runnerBudgetDimensionSchema = z.enum([
  "wall_time",
  "cpu_time",
  "memory",
  "pids",
  "writable_bytes",
  "log_bytes",
  "artifact_bytes",
  "command_count",
  "egress_bytes",
]);

export const artifactMediaTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/,
    "Expected a lowercase type/subtype media type without parameters.",
  );

export const runnerEventV2Schema = z.discriminatedUnion("type", [
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("workspace.prepared"),
    payload: z
      .object({
        sourceDigest: sha256DigestSchema,
        imageDigest: sha256DigestSchema,
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("action.started"),
    payload: z
      .object({
        commandIndex: nonNegativeSafeIntegerSchema,
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("action.completed"),
    payload: z
      .object({
        commandIndex: nonNegativeSafeIntegerSchema,
        exitCode: z.number().int(),
        durationMs: nonNegativeSafeIntegerSchema,
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("log.appended"),
    payload: z
      .object({
        stream: z.enum(["stdout", "stderr", "system"]),
        text: z.string().max(16_384),
        utf8Bytes: nonNegativeSafeIntegerSchema.max(65_536),
        redacted: z.boolean(),
      })
      .strict()
      .superRefine((payload, context) => {
        if (
          new TextEncoder().encode(payload.text).byteLength !==
          payload.utf8Bytes
        ) {
          context.addIssue({
            code: "custom",
            message: "utf8Bytes must equal the encoded log chunk size.",
            path: ["utf8Bytes"],
          });
        }
      }),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("artifact.produced"),
    payload: z
      .object({
        artifactId: entityIdSchema,
        digest: sha256DigestSchema,
        sizeBytes: nonNegativeSafeIntegerSchema,
        mediaType: artifactMediaTypeSchema,
        role: z.enum([
          "source_snapshot",
          "patch",
          "measurement",
          "report",
          "diagnostic",
        ]),
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("measurement.recorded"),
    payload: z
      .object({
        metricDefinitionId: entityIdSchema,
        amount: canonicalDecimalSchema,
        unit: z.string().trim().min(1).max(32),
        sampleCount: positiveSafeIntegerSchema,
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("task.succeeded"),
    payload: z
      .object({
        exitCode: z.literal(0),
        durationMs: nonNegativeSafeIntegerSchema,
      })
      .strict(),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("task.failed"),
    payload: z
      .object({
        classification: runnerFailureClassificationSchema,
        budgetDimension: runnerBudgetDimensionSchema.optional(),
        message: z.string().trim().min(1).max(4_000),
      })
      .strict()
      .superRefine((payload, context) => {
        if (
          (payload.classification === "budget") !==
          (payload.budgetDimension !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A budget failure requires exactly one exceeded budget dimension.",
            path: ["budgetDimension"],
          });
        }
      }),
  }),
  runnerEventV2EnvelopeSchema.extend({
    type: z.literal("task.cancelled"),
    payload: z
      .object({
        forced: z.boolean(),
        durationMs: nonNegativeSafeIntegerSchema,
      })
      .strict(),
  }),
]);
export type RunnerEventV2 = z.infer<typeof runnerEventV2Schema>;

export const runnerEventAcknowledgementV1Schema = z
  .object({
    version: z.literal("1"),
    eventId: entityIdSchema,
    attemptId: entityIdSchema,
    acknowledgedSequence: positiveSafeIntegerSchema,
    expectedSequence: positiveSafeIntegerSchema,
    receivedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (
      acknowledgement.acknowledgedSequence >= Number.MAX_SAFE_INTEGER ||
      acknowledgement.expectedSequence !==
        acknowledgement.acknowledgedSequence + 1
    ) {
      context.addIssue({
        code: "custom",
        message:
          "expectedSequence must immediately follow acknowledgedSequence.",
        path: ["expectedSequence"],
      });
    }
  });
export type RunnerEventAcknowledgementV1 = z.infer<
  typeof runnerEventAcknowledgementV1Schema
>;

export const runEventResourceSchema = z
  .object({
    id: entityIdSchema,
    runId: entityIdSchema,
    sequence: nonNegativeSafeIntegerSchema.min(1),
    type: z.string().min(1),
    schemaVersion: z.string().min(1),
    payload: z.unknown(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type RunEventResource = z.infer<typeof runEventResourceSchema>;

export const runEventListResponseSchema = z
  .object({
    data: z.array(runEventResourceSchema),
    page: eventPageInfoSchema,
  })
  .strict();
