import { z } from "zod";

import {
  canonicalDecimalSchema,
  entityIdSchema,
  nonNegativeSafeIntegerSchema,
} from "./common";
import { eventPageInfoSchema } from "./pagination";

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
