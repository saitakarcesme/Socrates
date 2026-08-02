import { posix } from "node:path";

import { z } from "zod";

const maximumBytes = 2 ** 50;
const maximumDurationMs = 86_400_000;
const maximumCount = 1_000_000;
const maximumMicros = 1_000_000_000;

const positiveBytes = z.number().int().min(1).max(maximumBytes);
const positiveDuration = z.number().int().min(1).max(maximumDurationMs);
const nonNegativeDuration = z.number().int().min(0).max(maximumDurationMs);
const positiveCount = z.number().int().min(1).max(maximumCount);
const positiveMicros = z.number().int().min(1).max(maximumMicros);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function issue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({
    code: "custom",
    message,
    path: [...path],
  });
}

const deploymentId = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);

const controlPlaneOrigin = z
  .string()
  .max(2_048)
  .superRefine((candidate, context) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      issue(context, [], "Control-plane origin is invalid.");
      return;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      candidate !== url.origin
    ) {
      issue(context, [], "Control-plane value must be one exact HTTPS origin.");
    }
  });

const privateRoot = z
  .string()
  .max(4_096)
  .superRefine((candidate, context) => {
    if (
      Buffer.byteLength(candidate, "utf8") > 4_096 ||
      hasControlCharacter(candidate) ||
      candidate.includes(",") ||
      candidate !== candidate.normalize("NFC") ||
      !candidate.startsWith("/") ||
      candidate === "/" ||
      candidate !== posix.normalize(candidate) ||
      candidate.endsWith("/")
    ) {
      issue(
        context,
        [],
        "Private root must be one canonical absolute POSIX path.",
      );
    }
  });

const executable = z
  .string()
  .max(4_096)
  .superRefine((candidate, context) => {
    if (
      candidate.length === 0 ||
      candidate !== candidate.trim() ||
      candidate.includes("\0")
    ) {
      issue(context, [], "Engine executable is invalid.");
    }
  });

const identitySchema = z
  .object({
    deploymentId,
    runnerId: z.uuid(),
  })
  .strict();

const controlPlaneSchema = z
  .object({
    origin: controlPlaneOrigin,
    timeoutMs: positiveDuration,
    maximumResponseBytes: positiveBytes,
  })
  .strict();

const rootsSchema = z
  .object({
    artifacts: privateRoot,
    sources: privateRoot,
    journal: privateRoot,
    spool: privateRoot,
  })
  .strict()
  .superRefine((roots, context) => {
    const entries = Object.entries(roots);
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const [leftName, leftPath] = entries[left]!;
        const [rightName, rightPath] = entries[right]!;
        if (
          leftPath === rightPath ||
          leftPath.startsWith(`${rightPath}/`) ||
          rightPath.startsWith(`${leftPath}/`)
        ) {
          issue(
            context,
            [rightName],
            `Private roots ${leftName} and ${rightName} must not overlap.`,
          );
        }
      }
    }
  });

const engineSchema = z
  .object({
    executable,
    readinessTtlMs: positiveDuration,
    controlTimeoutMs: positiveDuration,
    executionTimeoutMs: positiveDuration,
    maximumControlOutputBytes: positiveBytes,
  })
  .strict();

const sourceSchema = z
  .object({
    maximumArchiveBytes: positiveBytes,
    maximumExpandedBytes: positiveBytes,
    maximumEntries: positiveCount,
    maximumFileBytes: positiveBytes,
    maximumPathBytes: positiveBytes,
    maximumComponentBytes: positiveBytes,
    maximumPathDepth: positiveCount,
  })
  .strict()
  .superRefine((source, context) => {
    if (source.maximumFileBytes > source.maximumExpandedBytes) {
      issue(
        context,
        ["maximumFileBytes"],
        "Source file bytes cannot exceed expanded bytes.",
      );
    }
    if (source.maximumComponentBytes > source.maximumPathBytes) {
      issue(
        context,
        ["maximumComponentBytes"],
        "Source component bytes cannot exceed path bytes.",
      );
    }
  });

const requestSchema = z.object({ maximumBytes: positiveBytes }).strict();

const runtimeSchema = z
  .object({
    maximumProtocolBytes: positiveBytes,
    maximumChildOutputBytes: positiveBytes,
  })
  .strict();

const executionSchema = z
  .object({
    maximumWallTimeMs: positiveDuration,
    maximumMemoryBytes: positiveBytes,
    maximumPids: positiveCount,
    maximumWritableBytes: positiveBytes,
    maximumRuntimeOutputBytes: positiveBytes,
    maximumCommandCount: positiveCount,
    temporaryBytes: positiveBytes,
    sharedMemoryBytes: positiveBytes,
    cpuQuotaPeriodMicros: positiveMicros,
    minimumCpuQuotaMicros: positiveMicros,
    maximumCpuQuotaMicros: positiveMicros,
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.minimumCpuQuotaMicros > execution.maximumCpuQuotaMicros) {
      issue(
        context,
        ["minimumCpuQuotaMicros"],
        "Minimum CPU quota cannot exceed maximum CPU quota.",
      );
    }
    if (!/^10*$/u.test(String(execution.cpuQuotaPeriodMicros))) {
      issue(
        context,
        ["cpuQuotaPeriodMicros"],
        "CPU quota period must be a power of ten.",
      );
    }
    const reserved = execution.temporaryBytes + execution.sharedMemoryBytes;
    if (
      !Number.isSafeInteger(reserved) ||
      reserved >= execution.maximumWritableBytes
    ) {
      issue(
        context,
        ["maximumWritableBytes"],
        "Writable reservations must leave positive workspace capacity.",
      );
    }
  });

const journalSchema = z
  .object({
    maximumManifestBytes: positiveBytes,
    maximumClaimBytes: positiveBytes,
    maximumItems: positiveCount,
    maximumJournalBytes: positiveBytes,
  })
  .strict()
  .superRefine((journal, context) => {
    if (journal.maximumManifestBytes > journal.maximumJournalBytes) {
      issue(
        context,
        ["maximumManifestBytes"],
        "Journal manifest bytes cannot exceed total bytes.",
      );
    }
    if (journal.maximumClaimBytes > journal.maximumJournalBytes) {
      issue(
        context,
        ["maximumClaimBytes"],
        "Journal claim bytes cannot exceed total bytes.",
      );
    }
  });

const spoolSchema = z
  .object({
    maximumSegmentBytes: positiveBytes,
    maximumEventsPerSegment: positiveCount,
    maximumAttempts: positiveCount,
    maximumSpoolBytes: positiveBytes,
  })
  .strict()
  .superRefine((spool, context) => {
    if (spool.maximumSegmentBytes > spool.maximumSpoolBytes) {
      issue(
        context,
        ["maximumSegmentBytes"],
        "Spool segment bytes cannot exceed total bytes.",
      );
    }
  });

const durabilitySchema = z
  .object({ journal: journalSchema, spool: spoolSchema })
  .strict();

const lifecycleSchema = z
  .object({
    leaseDurationMs: positiveDuration,
    heartbeatIntervalMs: positiveDuration,
    revocationGracePeriodMs: nonNegativeDuration,
    maximumRecoveryAttempts: z.number().int().min(0).max(100),
    pollIntervalMs: positiveDuration,
  })
  .strict()
  .superRefine((lifecycle, context) => {
    if (lifecycle.heartbeatIntervalMs >= lifecycle.leaseDurationMs) {
      issue(
        context,
        ["heartbeatIntervalMs"],
        "Heartbeat interval must be shorter than lease duration.",
      );
    }
    if (lifecycle.revocationGracePeriodMs > lifecycle.leaseDurationMs) {
      issue(
        context,
        ["revocationGracePeriodMs"],
        "Revocation grace cannot exceed lease duration.",
      );
    }
  });

export const localRunnerConfigurationV1Schema = z
  .object({
    version: z.literal("1"),
    identity: identitySchema,
    controlPlane: controlPlaneSchema,
    roots: rootsSchema,
    engine: engineSchema,
    source: sourceSchema,
    request: requestSchema,
    runtime: runtimeSchema,
    execution: executionSchema,
    durability: durabilitySchema,
    lifecycle: lifecycleSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    for (const field of [
      "maximumProtocolBytes",
      "maximumChildOutputBytes",
    ] as const) {
      if (
        configuration.runtime[field] >
        configuration.execution.maximumRuntimeOutputBytes
      ) {
        issue(
          context,
          ["runtime", field],
          `${field} cannot exceed execution output authority.`,
        );
      }
    }
    if (
      configuration.engine.executionTimeoutMs <
      configuration.execution.maximumWallTimeMs
    ) {
      issue(
        context,
        ["engine", "executionTimeoutMs"],
        "Engine execution timeout cannot be shorter than wall-time policy.",
      );
    }
  });

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type LocalRunnerConfigurationV1 = DeepReadonly<
  z.infer<typeof localRunnerConfigurationV1Schema>
>;
