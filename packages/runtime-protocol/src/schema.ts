import { declaredCommandSchema, sha256DigestSchema } from "@socrates/contracts";
import { z } from "zod";

const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const entityId = z.uuid();
const base64Bytes = z
  .string()
  .max(87_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const runtimeAbi = "socrates.task-runtime.v1" as const;
export const runtimeRequestSchemaName =
  "socrates.task-runtime.request.v1" as const;

export const runtimeRequestSchema = z
  .object({
    schema: z.literal(runtimeRequestSchemaName),
    identity: z
      .object({
        runnerId: entityId,
        taskId: entityId,
        attemptId: entityId,
        fence: positiveSafeInteger,
      })
      .strict(),
    source: z
      .object({
        digest: sha256DigestSchema,
        path: z.literal("/socrates/source"),
      })
      .strict(),
    actions: z.array(declaredCommandSchema).min(1).max(64),
    measurement: z
      .object({
        metricDefinitionId: entityId,
        protocolRevision: positiveSafeInteger,
        unit: z.string().trim().min(1).max(32),
        command: declaredCommandSchema,
        maximumResultBytes: positiveSafeInteger.max(1_048_576),
      })
      .strict(),
    budget: z
      .object({
        wallTimeMs: positiveSafeInteger,
        writableBytes: positiveSafeInteger,
        outputBytes: positiveSafeInteger,
        commandCount: positiveSafeInteger,
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.actions.length + 1 > request.budget.commandCount) {
      context.addIssue({
        code: "custom",
        message: "Runtime request exceeds its command budget.",
        path: ["budget", "commandCount"],
      });
    }
    for (const [index, command] of [
      ...request.actions,
      request.measurement.command,
    ].entries()) {
      if (command.timeoutMs > request.budget.wallTimeMs) {
        context.addIssue({
          code: "custom",
          message: "Command timeout exceeds the runtime wall-time budget.",
          path:
            index < request.actions.length
              ? ["actions", index, "timeoutMs"]
              : ["measurement", "command", "timeoutMs"],
        });
      }
    }
  });

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

const commandAddress = {
  phase: z.enum(["action", "measurement"]),
  commandIndex: nonNegativeSafeInteger.max(64),
} as const;

const handshakeFrameSchema = z
  .object({
    type: z.literal("runtime.handshake"),
    abi: z.literal(runtimeAbi),
    buildDigest: sha256DigestSchema,
  })
  .strict();

const commandStartedFrameSchema = z
  .object({
    type: z.literal("command.started"),
    ...commandAddress,
  })
  .strict();

const commandOutputFrameSchema = z
  .object({
    type: z.literal("command.output"),
    ...commandAddress,
    stream: z.enum(["stdout", "stderr"]),
    sequence: nonNegativeSafeInteger,
    bytes: base64Bytes,
  })
  .strict();

const commandExitedFrameSchema = z
  .object({
    type: z.literal("command.exited"),
    ...commandAddress,
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    durationMs: nonNegativeSafeInteger,
  })
  .strict()
  .superRefine((frame, context) => {
    if (
      (frame.exitCode === null && frame.signal === null) ||
      (frame.exitCode !== null && frame.signal !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Command exit requires exactly one of exitCode or signal.",
      });
    }
  });

const measurementResultFrameSchema = z
  .object({
    type: z.literal("measurement.result"),
    sequence: nonNegativeSafeInteger,
    final: z.boolean(),
    bytes: base64Bytes,
  })
  .strict();

const runtimeErrorFrameSchema = z
  .object({
    type: z.literal("runtime.error"),
    code: z.enum([
      "invalid_request",
      "source_copy_failed",
      "command_failed",
      "command_timeout",
      "measurement_failed",
      "internal_error",
    ]),
    message: z.string().min(1).max(1_024),
  })
  .strict();

const runtimeCompletedFrameSchema = z
  .object({
    type: z.literal("runtime.completed"),
    status: z.enum(["succeeded", "failed"]),
  })
  .strict();

export const runtimeFrameSchema = z.discriminatedUnion("type", [
  handshakeFrameSchema,
  commandStartedFrameSchema,
  commandOutputFrameSchema,
  commandExitedFrameSchema,
  measurementResultFrameSchema,
  runtimeErrorFrameSchema,
  runtimeCompletedFrameSchema,
]);

export type RuntimeFrame = z.infer<typeof runtimeFrameSchema>;
