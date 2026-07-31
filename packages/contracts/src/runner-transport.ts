import { z } from "zod";

import { entityIdSchema, positiveSafeIntegerSchema } from "./common";
import {
  runnerEventAcknowledgementV1Schema,
  runnerEventV2Schema,
} from "./event";
import {
  runnerCancellationPolicyV1Schema,
  runnerExecutionV1Schema,
} from "./runner";
import { runnerTaskDeliveryV1Schema } from "./runner-delivery";

export const maximumRunnerLeaseDurationMs = 15 * 60 * 1_000;

export const runnerBearerTokenSchema = z
  .string()
  .regex(
    /^srt1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
    "Expected a versioned Socrates runner credential.",
  );
export type RunnerBearerToken = z.infer<typeof runnerBearerTokenSchema>;

export const runnerTaskClaimParamsV1Schema = z
  .object({ taskId: entityIdSchema })
  .strict();

export const runnerTaskClaimRequestV1Schema = z
  .object({
    version: z.literal("1"),
    attemptId: entityIdSchema,
    leaseDurationMs: positiveSafeIntegerSchema.max(
      maximumRunnerLeaseDurationMs,
    ),
  })
  .strict();
export type RunnerTaskClaimRequestV1 = z.infer<
  typeof runnerTaskClaimRequestV1Schema
>;

export const runnerTaskClaimResponseV1Schema = z
  .object({
    version: z.literal("1"),
    execution: runnerExecutionV1Schema,
  })
  .strict();
export type RunnerTaskClaimResponseV1 = z.infer<
  typeof runnerTaskClaimResponseV1Schema
>;

export const runnerTaskDeliveryAcquireRequestV1Schema = z
  .object({ version: z.literal("1") })
  .strict();
export type RunnerTaskDeliveryAcquireRequestV1 = z.infer<
  typeof runnerTaskDeliveryAcquireRequestV1Schema
>;

export const runnerTaskDeliveryAcquireResponseV1Schema = z
  .object({
    version: z.literal("1"),
    delivery: runnerTaskDeliveryV1Schema,
  })
  .strict();
export type RunnerTaskDeliveryAcquireResponseV1 = z.infer<
  typeof runnerTaskDeliveryAcquireResponseV1Schema
>;

export const runnerTaskDeliveryClaimParamsV1Schema = z
  .object({ deliveryId: entityIdSchema })
  .strict();

export const runnerTaskDeliveryClaimRequestV1Schema = z
  .object({
    version: z.literal("1"),
    taskId: entityIdSchema,
    attemptId: entityIdSchema,
    leaseDurationMs: positiveSafeIntegerSchema.max(
      maximumRunnerLeaseDurationMs,
    ),
  })
  .strict();
export type RunnerTaskDeliveryClaimRequestV1 = z.infer<
  typeof runnerTaskDeliveryClaimRequestV1Schema
>;

export const runnerTaskHeartbeatParamsV1Schema = z
  .object({
    taskId: entityIdSchema,
    attemptId: entityIdSchema,
  })
  .strict();

export const runnerTaskHeartbeatRequestV1Schema = z
  .object({
    version: z.literal("1"),
    fence: positiveSafeIntegerSchema,
    leaseDurationMs: positiveSafeIntegerSchema.max(
      maximumRunnerLeaseDurationMs,
    ),
  })
  .strict();
export type RunnerTaskHeartbeatRequestV1 = z.infer<
  typeof runnerTaskHeartbeatRequestV1Schema
>;

export const runnerTaskHeartbeatResponseV1Schema = z.discriminatedUnion(
  "directive",
  [
    z
      .object({
        version: z.literal("1"),
        leaseExpiresAt: z.iso.datetime(),
        directive: z.literal("continue"),
      })
      .strict(),
    z
      .object({
        version: z.literal("1"),
        leaseExpiresAt: z.iso.datetime(),
        directive: z.literal("cancel"),
        cancellation: runnerCancellationPolicyV1Schema,
      })
      .strict(),
  ],
);
export type RunnerTaskHeartbeatResponseV1 = z.infer<
  typeof runnerTaskHeartbeatResponseV1Schema
>;

export const runnerEventSubmitRequestV1Schema = z
  .object({
    version: z.literal("1"),
    event: runnerEventV2Schema,
  })
  .strict();
export type RunnerEventSubmitRequestV1 = z.infer<
  typeof runnerEventSubmitRequestV1Schema
>;

export const runnerEventSubmitResponseV1Schema = z
  .object({
    version: z.literal("1"),
    replay: z.boolean(),
    acknowledgement: runnerEventAcknowledgementV1Schema,
  })
  .strict();
export type RunnerEventSubmitResponseV1 = z.infer<
  typeof runnerEventSubmitResponseV1Schema
>;
