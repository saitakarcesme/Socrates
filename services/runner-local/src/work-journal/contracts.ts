import { z } from "zod";

import {
  apiErrorCodeSchema,
  runnerExecutionV1Schema,
} from "@socrates/contracts";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const keySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const workJournalLimitsSchema = z
  .object({
    maximumManifestBytes: positiveSafeIntegerSchema,
    maximumClaimBytes: positiveSafeIntegerSchema,
    maximumItems: positiveSafeIntegerSchema,
    maximumJournalBytes: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((limits, context) => {
    for (const name of ["maximumManifestBytes", "maximumClaimBytes"] as const) {
      if (limits[name] > limits.maximumJournalBytes) {
        context.addIssue({
          code: "custom",
          message: `${name} cannot exceed maximumJournalBytes.`,
          path: [name],
        });
      }
    }
  });
export type WorkJournalLimits = z.infer<typeof workJournalLimitsSchema>;

export const workManifestCoreSchema = z
  .object({
    version: z.literal("1"),
    deliveryKey: keySchema,
    identity: z
      .object({
        deliveryId: z.uuid(),
        taskId: z.uuid(),
        attemptId: z.uuid(),
      })
      .strict(),
    admittedAt: z.iso.datetime(),
  })
  .strict();
export type WorkManifestCore = z.infer<typeof workManifestCoreSchema>;

export const workManifestSchema = workManifestCoreSchema
  .safeExtend({ checksum: digestSchema })
  .strict();
export type WorkManifest = z.infer<typeof workManifestSchema>;

export const workClaimCoreSchema = z
  .object({
    version: z.literal("1"),
    deliveryKey: keySchema,
    executionDigest: digestSchema,
    execution: runnerExecutionV1Schema,
    committedAt: z.iso.datetime(),
  })
  .strict();
export type WorkClaimCore = z.infer<typeof workClaimCoreSchema>;

export const workClaimSchema = workClaimCoreSchema
  .safeExtend({ checksum: digestSchema })
  .strict();
export type WorkClaim = z.infer<typeof workClaimSchema>;

export const workRejectionCoreSchema = z
  .object({
    version: z.literal("1"),
    deliveryKey: keySchema,
    reason: z.literal("control_plane_conflict"),
    response: z
      .object({
        status: z.literal(409),
        apiCode: apiErrorCodeSchema,
        requestId: z.string().min(1),
      })
      .strict(),
    committedAt: z.iso.datetime(),
  })
  .strict();
export type WorkRejectionCore = z.infer<typeof workRejectionCoreSchema>;

export const workRejectionSchema = workRejectionCoreSchema
  .safeExtend({ checksum: digestSchema })
  .strict();
export type WorkRejection = z.infer<typeof workRejectionSchema>;

export type WorkJournalState = Readonly<{
  deliveryId: string;
  taskId: string;
  attemptId: string;
  state: "pending_claim" | "claimed" | "rejected";
  admittedAt: string;
  claimedAt?: string;
  rejectedAt?: string;
  rejection?: WorkRejectionCore["response"] & {
    reason: WorkRejectionCore["reason"];
  };
}>;

export type WorkJournalErrorCode =
  | "capacity_exceeded"
  | "corrupt"
  | "identity_conflict"
  | "invalid_configuration";

export class WorkJournalError extends Error {
  constructor(
    readonly code: WorkJournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkJournalError";
  }
}
