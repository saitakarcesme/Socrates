import { createHash } from "node:crypto";

import {
  runnerEventV2Schema,
  runnerExecutionV1Schema,
  type RunnerEventV2,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import type { RunnerEventDraft } from "../lifecycle/draft";
import {
  spoolAcknowledgementStateSchema,
  spoolCommitSchema,
  spoolManifestSchema,
  spoolSegmentCoreSchema,
  spoolSegmentSchema,
  SpoolError,
  type SpoolAcknowledgementState,
  type SpoolAttemptIdentity,
  type SpoolCommit,
  type SpoolManifest,
  type SpoolSegment,
  type SpoolSegmentCore,
} from "./contracts";

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseCanonical<T>(
  bytes: Uint8Array,
  parse: (value: unknown) => T,
  label: string,
): T {
  let text: string;
  let raw: unknown;
  try {
    text = fatalUtf8Decoder.decode(bytes);
    raw = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new SpoolError("corrupt", `${label} is not valid UTF-8 JSON.`, {
      cause,
    });
  }

  let parsed: T;
  try {
    parsed = parse(raw);
  } catch (cause) {
    throw new SpoolError("corrupt", `${label} does not match its schema.`, {
      cause,
    });
  }
  if (canonicalJson(parsed) !== text) {
    throw new SpoolError("corrupt", `${label} is not canonical JSON.`);
  }
  return deepFreeze(parsed);
}

export function executionIdentity(
  input: RunnerExecutionV1,
): SpoolAttemptIdentity {
  const execution = runnerExecutionV1Schema.parse(input);
  return deepFreeze({
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
  });
}

export function attemptKeyFor(input: RunnerExecutionV1): string {
  return sha256(canonicalJson(executionIdentity(input)));
}

export function executionDigestFor(input: RunnerExecutionV1): string {
  const execution = runnerExecutionV1Schema.parse(input);
  return `sha256:${sha256(canonicalJson(execution))}`;
}

export function createManifest(
  input: RunnerExecutionV1,
  createdAt: string,
): SpoolManifest {
  return deepFreeze(
    spoolManifestSchema.parse({
      version: "1",
      attemptKey: attemptKeyFor(input),
      executionDigest: executionDigestFor(input),
      identity: executionIdentity(input),
      createdAt,
    }),
  );
}

export function encodeCanonical(value: unknown): Uint8Array {
  return canonicalBytes(value);
}

export function decodeManifest(bytes: Uint8Array): SpoolManifest {
  return parseCanonical(
    bytes,
    (value) => spoolManifestSchema.parse(value),
    "Spool manifest",
  );
}

export function createSegment(input: {
  execution: RunnerExecutionV1;
  drafts: readonly RunnerEventDraft[];
  startSequence: number;
  occurredAt: string;
  eventIds: readonly string[];
}): SpoolSegment {
  const execution = runnerExecutionV1Schema.parse(input.execution);
  if (input.drafts.length < 1) {
    throw new RangeError("A spool segment requires at least one event draft.");
  }
  if (input.eventIds.length !== input.drafts.length) {
    throw new RangeError("Every event draft requires one event ID.");
  }
  if (new Set(input.eventIds).size !== input.eventIds.length) {
    throw new SpoolError("corrupt", "Spool event IDs must be unique.");
  }
  const endSequence = input.startSequence + input.drafts.length - 1;
  if (
    !Number.isSafeInteger(input.startSequence) ||
    input.startSequence < 1 ||
    !Number.isSafeInteger(endSequence)
  ) {
    throw new RangeError(
      "Spool event sequences must be positive safe integers.",
    );
  }

  const events = input.drafts.map((draft, index) =>
    runnerEventV2Schema.parse({
      version: "2",
      eventId: input.eventIds[index],
      runnerId: execution.lease.runnerId,
      taskId: execution.lease.taskId,
      attemptId: execution.lease.attemptId,
      fence: execution.lease.fence,
      sequence: input.startSequence + index,
      occurredAt: input.occurredAt,
      type: draft.type,
      payload: draft.payload,
    }),
  );
  const core = spoolSegmentCoreSchema.parse({
    version: "1",
    attemptKey: attemptKeyFor(execution),
    startSequence: input.startSequence,
    endSequence,
    events,
  });
  return deepFreeze(
    spoolSegmentSchema.parse({
      ...core,
      checksum: segmentChecksum(core),
    }),
  );
}

export function segmentChecksum(core: SpoolSegmentCore): string {
  return `sha256:${sha256(canonicalJson(core))}`;
}

export function decodeSegment(bytes: Uint8Array): SpoolSegment {
  const segment = parseCanonical(
    bytes,
    (value) => spoolSegmentSchema.parse(value),
    "Spool segment",
  );
  const { checksum, ...coreValue } = segment;
  const core = spoolSegmentCoreSchema.parse(coreValue);
  if (checksum !== segmentChecksum(core)) {
    throw new SpoolError("corrupt", "Spool segment checksum does not match.");
  }
  return segment;
}

export function createCommit(
  segment: SpoolSegment,
  segmentName: string,
): SpoolCommit {
  const terminal = segment.events.at(-1);
  if (
    !terminal ||
    !["task.succeeded", "task.failed", "task.cancelled"].includes(terminal.type)
  ) {
    throw new SpoolError(
      "corrupt",
      "A spool commit requires a terminal final event.",
    );
  }
  return deepFreeze(
    spoolCommitSchema.parse({
      version: "1",
      attemptKey: segment.attemptKey,
      segmentName,
      segmentChecksum: segment.checksum,
      startSequence: segment.startSequence,
      endSequence: segment.endSequence,
      terminalEventId: terminal.eventId,
    }),
  );
}

export function decodeCommit(bytes: Uint8Array): SpoolCommit {
  return parseCanonical(
    bytes,
    (value) => spoolCommitSchema.parse(value),
    "Spool commit marker",
  );
}

export function decodeAcknowledgement(
  bytes: Uint8Array,
): SpoolAcknowledgementState {
  return parseCanonical(
    bytes,
    (value) => spoolAcknowledgementStateSchema.parse(value),
    "Spool acknowledgement",
  );
}

export function immutableEvents(
  events: readonly RunnerEventV2[],
): readonly RunnerEventV2[] {
  return deepFreeze(events.map((event) => runnerEventV2Schema.parse(event)));
}
