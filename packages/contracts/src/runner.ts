import { z } from "zod";

import {
  canonicalDecimalSchema,
  entityIdSchema,
  metricDirectionSchema,
  nonNegativeCanonicalDecimalSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./common";

const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;
const workspacePathPattern = /^\/workspace(?:\/(?!\.{1,2}(?:\/|$))[^/\0]+)*$/;

export const sha256DigestSchema = z
  .string()
  .regex(sha256DigestPattern, "Expected a lowercase SHA-256 digest.");

export const runnerKindSchema = z.enum(["local", "cloud", "distributed"]);

export const runnerCapabilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sandbox.oci"),
      platform: z.literal("linux"),
      architecture: z.enum(["amd64", "arm64"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action.command"),
      shell: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("network.egress"),
      mode: z.enum(["disabled", "allowlist"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accelerator.nvidia"),
      maximumDevices: positiveSafeIntegerSchema.max(64),
    })
    .strict(),
]);
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>;

export const runnerRegistrationV1Schema = z
  .object({
    version: z.literal("1"),
    runnerId: entityIdSchema,
    kind: runnerKindSchema,
    softwareVersion: z.string().trim().min(1).max(64),
    taskProtocolVersions: z.tuple([z.literal("2")]),
    eventProtocolVersions: z.tuple([z.literal("2")]),
    sandboxBackend: z.literal("oci"),
    capabilities: z.array(runnerCapabilitySchema).min(2).max(32),
    capacity: z
      .object({
        maximumConcurrentTasks: positiveSafeIntegerSchema.max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((registration, context) => {
    const capabilityKinds = registration.capabilities.map(
      (capability) => capability.kind,
    );
    if (new Set(capabilityKinds).size !== capabilityKinds.length) {
      context.addIssue({
        code: "custom",
        message: "A runner can advertise each capability kind only once.",
        path: ["capabilities"],
      });
    }
    for (const required of ["sandbox.oci", "action.command"] as const) {
      if (!capabilityKinds.includes(required)) {
        context.addIssue({
          code: "custom",
          message: `Runner registration requires ${required}.`,
          path: ["capabilities"],
        });
      }
    }
  });
export type RunnerRegistrationV1 = z.infer<typeof runnerRegistrationV1Schema>;

export const declaredCommandSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => {
        const segments = value.split("/");
        return (
          segments[0] === "" &&
          segments.length > 1 &&
          segments
            .slice(1)
            .every(
              (segment) =>
                segment.length > 0 &&
                segment !== "." &&
                segment !== ".." &&
                !segment.includes("\0"),
            )
        );
      }, "Executable must be a normalized absolute path."),
    arguments: z
      .array(
        z
          .string()
          .max(4_096)
          .refine(
            (value) => !value.includes("\0"),
            "Command arguments cannot contain null bytes.",
          ),
      )
      .max(128),
    workingDirectory: z
      .string()
      .regex(
        workspacePathPattern,
        "Working directory must stay within /workspace.",
      ),
    timeoutMs: positiveSafeIntegerSchema,
  })
  .strict();
export type DeclaredCommand = z.infer<typeof declaredCommandSchema>;

export const runnerNetworkPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      destinations: z
        .array(
          z
            .object({
              host: z
                .string()
                .trim()
                .min(1)
                .max(253)
                .regex(
                  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/,
                  "Expected a lowercase DNS hostname.",
                ),
              ports: z
                .array(z.number().int().min(1).max(65_535))
                .min(1)
                .max(32),
            })
            .strict(),
        )
        .min(1)
        .max(32),
    })
    .strict(),
]);
export type RunnerNetworkPolicy = z.infer<typeof runnerNetworkPolicySchema>;

export const runnerBudgetSchema = z
  .object({
    wallTimeMs: positiveSafeIntegerSchema,
    cpuTimeMs: positiveSafeIntegerSchema,
    memoryBytes: positiveSafeIntegerSchema,
    maximumPids: positiveSafeIntegerSchema,
    writableBytes: positiveSafeIntegerSchema,
    logBytes: positiveSafeIntegerSchema,
    artifactBytes: positiveSafeIntegerSchema,
    commandCount: positiveSafeIntegerSchema,
    egressBytes: nonNegativeSafeIntegerSchema,
  })
  .strict();
export type RunnerBudget = z.infer<typeof runnerBudgetSchema>;

export const frozenConstraintSchema = z
  .object({
    definitionId: entityIdSchema,
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
export type FrozenConstraint = z.infer<typeof frozenConstraintSchema>;

export const experimentTaskV2Schema = z
  .object({
    version: z.literal("2"),
    taskId: entityIdSchema,
    runId: entityIdSchema,
    experimentId: entityIdSchema,
    source: z
      .object({
        snapshotId: entityIdSchema,
        digest: sha256DigestSchema,
      })
      .strict(),
    hypothesis: z.string().trim().min(1).max(4_000),
    action: z
      .object({
        kind: z.literal("command-sequence"),
        revision: sha256DigestSchema,
        steps: z.array(declaredCommandSchema).min(1).max(64),
        retrySafe: z.boolean(),
      })
      .strict(),
    measurement: z
      .object({
        metricDefinitionId: entityIdSchema,
        protocolRevision: positiveSafeIntegerSchema,
        unit: z.string().trim().min(1).max(32),
        direction: metricDirectionSchema,
        minimumImprovement: nonNegativeCanonicalDecimalSchema,
        noiseTolerance: nonNegativeCanonicalDecimalSchema,
        command: declaredCommandSchema,
        result: z
          .object({
            kind: z.literal("json-stdout"),
            schema: z.literal("metric-value.v1"),
            maximumBytes: positiveSafeIntegerSchema.max(1_048_576),
          })
          .strict(),
      })
      .strict(),
    constraints: z.array(frozenConstraintSchema).max(20),
    environment: z
      .object({
        imageDigest: sha256DigestSchema,
        platform: z.literal("linux"),
        architecture: z.enum(["amd64", "arm64"]),
        network: runnerNetworkPolicySchema,
        requiredCapabilities: z.array(runnerCapabilitySchema).min(2).max(32),
      })
      .strict(),
    budget: runnerBudgetSchema,
  })
  .strict()
  .superRefine((task, context) => {
    const commands = [...task.action.steps, task.measurement.command];
    if (
      commands.some((command) => command.timeoutMs > task.budget.wallTimeMs)
    ) {
      context.addIssue({
        code: "custom",
        message: "Command timeout cannot exceed the task wall-time budget.",
        path: ["budget", "wallTimeMs"],
      });
    }

    if (
      task.environment.network.mode === "disabled" &&
      task.budget.egressBytes !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Disabled networking requires a zero egress budget.",
        path: ["budget", "egressBytes"],
      });
    }

    const capabilityKinds = task.environment.requiredCapabilities.map(
      (capability) => capability.kind,
    );
    if (new Set(capabilityKinds).size !== capabilityKinds.length) {
      context.addIssue({
        code: "custom",
        message: "A task can require each capability kind only once.",
        path: ["environment", "requiredCapabilities"],
      });
    }

    const sandboxCapability = task.environment.requiredCapabilities.find(
      (capability) => capability.kind === "sandbox.oci",
    );
    if (
      sandboxCapability?.platform !== task.environment.platform ||
      sandboxCapability.architecture !== task.environment.architecture
    ) {
      context.addIssue({
        code: "custom",
        message: "Required OCI capability must exactly match the environment.",
        path: ["environment", "requiredCapabilities"],
      });
    }

    if (
      !task.environment.requiredCapabilities.some(
        (capability) =>
          capability.kind === "action.command" && !capability.shell,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Command-sequence actions require non-shell command support.",
        path: ["environment", "requiredCapabilities"],
      });
    }

    const networkCapabilities = task.environment.requiredCapabilities.filter(
      (capability) => capability.kind === "network.egress",
    );
    if (
      networkCapabilities.length !== 1 ||
      networkCapabilities[0]?.mode !== task.environment.network.mode
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Required network capability must exactly match the network policy.",
        path: ["environment", "requiredCapabilities"],
      });
    }
  });
export type ExperimentTaskV2 = z.infer<typeof experimentTaskV2Schema>;

export const executableExperimentTaskSchema = experimentTaskV2Schema;
export type ExecutableExperimentTask = ExperimentTaskV2;

export const runnerAttemptLeaseV1Schema = z
  .object({
    version: z.literal("1"),
    runnerId: entityIdSchema,
    taskId: entityIdSchema,
    attemptId: entityIdSchema,
    fence: positiveSafeIntegerSchema,
    leasedUntil: z.iso.datetime(),
  })
  .strict();
export type RunnerAttemptLeaseV1 = z.infer<typeof runnerAttemptLeaseV1Schema>;

export const runnerExecutionV1Schema = z
  .object({
    version: z.literal("1"),
    lease: runnerAttemptLeaseV1Schema,
    task: experimentTaskV2Schema,
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.lease.taskId !== execution.task.taskId) {
      context.addIssue({
        code: "custom",
        message: "Lease and task identifiers must match.",
        path: ["lease", "taskId"],
      });
    }
  });
export type RunnerExecutionV1 = z.infer<typeof runnerExecutionV1Schema>;

export const runnerCancellationV1Schema = z
  .object({
    version: z.literal("1"),
    runnerId: entityIdSchema,
    taskId: entityIdSchema,
    attemptId: entityIdSchema,
    fence: positiveSafeIntegerSchema,
    requestedAt: z.iso.datetime(),
    gracePeriodMs: nonNegativeSafeIntegerSchema.max(60_000),
    reason: z.enum(["operator", "budget", "policy", "runner_shutdown"]),
  })
  .strict();
export type RunnerCancellationV1 = z.infer<typeof runnerCancellationV1Schema>;
