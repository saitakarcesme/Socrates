import { createHash } from "node:crypto";

import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import {
  workClaimCoreSchema,
  workClaimSchema,
  workManifestCoreSchema,
  workManifestSchema,
  workRejectionCoreSchema,
  workRejectionSchema,
  WorkJournalError,
  type WorkClaim,
  type WorkClaimCore,
  type WorkManifest,
  type WorkManifestCore,
  type WorkRejection,
  type WorkRejectionCore,
} from "./contracts";

const decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function checksum(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function decodeCanonical<T>(
  bytes: Uint8Array,
  parse: (value: unknown) => T,
  label: string,
): T {
  let text: string;
  let raw: unknown;
  try {
    text = decoder.decode(bytes);
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WorkJournalError("corrupt", `${label} is not valid UTF-8 JSON.`, {
      cause,
    });
  }
  let parsed: T;
  try {
    parsed = parse(raw);
  } catch (cause) {
    throw new WorkJournalError(
      "corrupt",
      `${label} does not match its schema.`,
      { cause },
    );
  }
  if (canonicalJson(parsed) !== text) {
    throw new WorkJournalError("corrupt", `${label} is not canonical JSON.`);
  }
  return freezeDeep(parsed);
}

export function deliveryKeyFor(input: RunnerTaskDeliveryV1): string {
  return sha256(runnerTaskDeliveryV1Schema.parse(input).deliveryId);
}

export function encodeWorkRecord(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function createWorkManifest(input: {
  delivery: RunnerTaskDeliveryV1;
  attemptId: string;
  admittedAt: string;
}): WorkManifest {
  const delivery = runnerTaskDeliveryV1Schema.parse(input.delivery);
  const core = workManifestCoreSchema.parse({
    version: "1",
    deliveryKey: deliveryKeyFor(delivery),
    identity: {
      deliveryId: delivery.deliveryId,
      taskId: delivery.taskId,
      attemptId: input.attemptId,
    },
    admittedAt: input.admittedAt,
  });
  return freezeDeep(
    workManifestSchema.parse({ ...core, checksum: checksum(core) }),
  );
}

export function decodeWorkManifest(bytes: Uint8Array): WorkManifest {
  const manifest = decodeCanonical(
    bytes,
    (value) => workManifestSchema.parse(value),
    "Work manifest",
  );
  const { checksum: actual, ...rawCore } = manifest;
  const core: WorkManifestCore = workManifestCoreSchema.parse(rawCore);
  if (actual !== checksum(core))
    throw new WorkJournalError(
      "corrupt",
      "Work manifest checksum does not match.",
    );
  return manifest;
}

export function executionDigestFor(execution: RunnerExecutionV1): string {
  return checksum(runnerExecutionV1Schema.parse(execution));
}

export function createWorkClaim(input: {
  deliveryKey: string;
  execution: RunnerExecutionV1;
  committedAt: string;
}): WorkClaim {
  const execution = runnerExecutionV1Schema.parse(input.execution);
  const core = workClaimCoreSchema.parse({
    version: "1",
    deliveryKey: input.deliveryKey,
    executionDigest: executionDigestFor(execution),
    execution,
    committedAt: input.committedAt,
  });
  return freezeDeep(
    workClaimSchema.parse({ ...core, checksum: checksum(core) }),
  );
}

export function decodeWorkClaim(bytes: Uint8Array): WorkClaim {
  const claim = decodeCanonical(
    bytes,
    (value) => workClaimSchema.parse(value),
    "Work claim",
  );
  const { checksum: actual, ...rawCore } = claim;
  const core: WorkClaimCore = workClaimCoreSchema.parse(rawCore);
  if (
    actual !== checksum(core) ||
    claim.executionDigest !== executionDigestFor(claim.execution)
  ) {
    throw new WorkJournalError(
      "corrupt",
      "Work claim checksum or execution digest does not match.",
    );
  }
  return claim;
}

export function createWorkRejection(input: {
  deliveryKey: string;
  response: WorkRejectionCore["response"];
  committedAt: string;
}): WorkRejection {
  const core = workRejectionCoreSchema.parse({
    version: "1",
    deliveryKey: input.deliveryKey,
    reason: "control_plane_conflict",
    response: input.response,
    committedAt: input.committedAt,
  });
  return freezeDeep(
    workRejectionSchema.parse({ ...core, checksum: checksum(core) }),
  );
}

export function decodeWorkRejection(bytes: Uint8Array): WorkRejection {
  const rejection = decodeCanonical(
    bytes,
    (value) => workRejectionSchema.parse(value),
    "Work rejection",
  );
  const { checksum: actual, ...rawCore } = rejection;
  const core: WorkRejectionCore = workRejectionCoreSchema.parse(rawCore);
  if (actual !== checksum(core))
    throw new WorkJournalError(
      "corrupt",
      "Work rejection checksum does not match.",
    );
  return rejection;
}

export function immutableExecution(
  input: RunnerExecutionV1,
): RunnerExecutionV1 {
  return freezeDeep(runnerExecutionV1Schema.parse(input));
}
