import { z } from "zod";

import {
  runnerEventAcknowledgementV1Schema,
  runnerEventV2Schema,
} from "@socrates/contracts";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export const spoolAttemptIdentitySchema = z
  .object({
    runnerId: z.uuid(),
    taskId: z.uuid(),
    attemptId: z.uuid(),
    fence: positiveSafeIntegerSchema,
  })
  .strict();
export type SpoolAttemptIdentity = z.infer<typeof spoolAttemptIdentitySchema>;

export const spoolManifestSchema = z
  .object({
    version: z.literal("1"),
    attemptKey: sha256HexSchema,
    executionDigest: sha256DigestSchema,
    identity: spoolAttemptIdentitySchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type SpoolManifest = z.infer<typeof spoolManifestSchema>;

export const spoolSegmentCoreSchema = z
  .object({
    version: z.literal("1"),
    attemptKey: sha256HexSchema,
    startSequence: positiveSafeIntegerSchema,
    endSequence: positiveSafeIntegerSchema,
    events: z.array(runnerEventV2Schema).min(1),
  })
  .strict()
  .superRefine((segment, context) => {
    if (
      segment.startSequence > segment.endSequence ||
      segment.events.length !== segment.endSequence - segment.startSequence + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Segment range must exactly cover its events.",
        path: ["endSequence"],
      });
    }
    for (const [index, event] of segment.events.entries()) {
      if (event.sequence !== segment.startSequence + index) {
        context.addIssue({
          code: "custom",
          message: "Segment event sequences must be contiguous.",
          path: ["events", index, "sequence"],
        });
      }
    }
  });
export type SpoolSegmentCore = z.infer<typeof spoolSegmentCoreSchema>;

export const spoolSegmentSchema = spoolSegmentCoreSchema
  .safeExtend({ checksum: sha256DigestSchema })
  .strict();
export type SpoolSegment = z.infer<typeof spoolSegmentSchema>;

export const spoolCommitSchema = z
  .object({
    version: z.literal("1"),
    attemptKey: sha256HexSchema,
    segmentName: z.string().regex(/^\d{16}-\d{16}\.json$/u),
    segmentChecksum: sha256DigestSchema,
    startSequence: positiveSafeIntegerSchema,
    endSequence: positiveSafeIntegerSchema,
    terminalEventId: z.uuid(),
  })
  .strict()
  .refine(
    (commit) => commit.startSequence <= commit.endSequence,
    "Commit range must be ordered.",
  );
export type SpoolCommit = z.infer<typeof spoolCommitSchema>;

export const spoolAcknowledgementStateSchema = z
  .object({
    version: z.literal("1"),
    acknowledgement: runnerEventAcknowledgementV1Schema,
    terminal: z.boolean(),
  })
  .strict();
export type SpoolAcknowledgementState = z.infer<
  typeof spoolAcknowledgementStateSchema
>;

export const spoolLimitsSchema = z
  .object({
    maximumSegmentBytes: positiveSafeIntegerSchema,
    maximumEventsPerSegment: positiveSafeIntegerSchema,
    maximumAttempts: positiveSafeIntegerSchema,
    maximumSpoolBytes: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maximumSegmentBytes > limits.maximumSpoolBytes) {
      context.addIssue({
        code: "custom",
        message: "maximumSegmentBytes cannot exceed maximumSpoolBytes.",
        path: ["maximumSegmentBytes"],
      });
    }
  });
export type SpoolLimits = z.infer<typeof spoolLimitsSchema>;

export type SpoolState = Readonly<{
  attemptKey: string;
  acknowledgedSequence: number;
  lastSequence: number;
  pendingEvents: number;
  terminal: boolean;
}>;

export type SpoolErrorCode =
  | "acknowledgement_conflict"
  | "capacity_exceeded"
  | "concurrent_owner"
  | "corrupt"
  | "identity_conflict"
  | "invalid_configuration"
  | "terminal";

export class SpoolError extends Error {
  constructor(
    readonly code: SpoolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SpoolError";
  }
}
