import {
  runnerCancellationV1Schema,
  runnerExecutionV1Schema,
  type RunnerCancellationV1,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { z } from "zod";

import {
  sandboxTerminationReceipt,
  type SandboxTerminationReceipt,
} from "../oci/termination";
import {
  runnerEventDraft,
  terminalRunnerEventDrafts,
  type RunnerEventDraft,
} from "./draft";
import { localFailureEvidence } from "./failure-policy";

export type TerminalExecutionTiming =
  | Readonly<{ state: "not_started" }>
  | Readonly<{ state: "started"; elapsedMs: number }>;

export type TerminalOutcomeCandidate =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "runtime"; drafts: readonly RunnerEventDraft[] }>
  | Readonly<{ state: "failure"; draft: RunnerEventDraft }>;

export type TerminalAuthorityObservation =
  | Readonly<{ state: "renewed"; leaseExpiresAt: string }>
  | Readonly<{ state: "stale" }>
  | Readonly<{
      state: "uncertain";
      boundary: "heartbeat" | "revocation" | "scheduler";
    }>
  | Readonly<{
      state: "cancelled";
      cancellation: RunnerCancellationV1;
      termination: SandboxTerminationReceipt;
    }>;

export type TerminalOutcomeNoEvidenceReason =
  | "authority_lost"
  | "authority_uncertain"
  | "candidate_missing"
  | "observation_conflict";

export type TerminalOutcomeDecision =
  | Readonly<{
      state: "evidence";
      drafts: readonly RunnerEventDraft[];
    }>
  | Readonly<{
      state: "no_evidence";
      reason: TerminalOutcomeNoEvidenceReason;
    }>;

export class TerminalOutcomeArbiterError extends Error {
  constructor(
    readonly code: "identity_mismatch" | "invalid_input",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalOutcomeArbiterError";
  }
}

type ParsedCandidate =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "runtime"; drafts: readonly RunnerEventDraft[] }>
  | Readonly<{ state: "failure"; drafts: readonly RunnerEventDraft[] }>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function record(candidate: unknown): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("Expected an object.");
  }
  return candidate as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length &&
    observed.every((key, index) => key === expected[index])
  );
}

function parseTiming(candidate: unknown): TerminalExecutionTiming {
  const value = record(candidate);
  if (value["state"] === "not_started" && hasExactKeys(value, ["state"])) {
    return Object.freeze({ state: "not_started" });
  }
  if (
    value["state"] === "started" &&
    Number.isSafeInteger(value["elapsedMs"]) &&
    Number(value["elapsedMs"]) >= 0 &&
    hasExactKeys(value, ["state", "elapsedMs"])
  ) {
    return Object.freeze({
      state: "started",
      elapsedMs: Number(value["elapsedMs"]),
    });
  }
  throw new TypeError("Terminal execution timing is invalid.");
}

function parseCandidate(candidate: unknown): ParsedCandidate {
  const value = record(candidate);
  if (value["state"] === "none" && hasExactKeys(value, ["state"])) {
    return Object.freeze({ state: "none" });
  }
  if (
    value["state"] === "runtime" &&
    hasExactKeys(value, ["state", "drafts"])
  ) {
    return deepFreeze({
      state: "runtime",
      drafts: terminalRunnerEventDrafts(
        value["drafts"] as readonly RunnerEventDraft[],
      ),
    });
  }
  if (value["state"] === "failure" && hasExactKeys(value, ["state", "draft"])) {
    const draft = runnerEventDraft(value["draft"] as RunnerEventDraft);
    if (draft.type !== "task.failed") {
      throw new TypeError("A local failure candidate must be task.failed.");
    }
    return deepFreeze({
      state: "failure",
      drafts: terminalRunnerEventDrafts([draft]),
    });
  }
  throw new TypeError("Terminal outcome candidate is invalid.");
}

function parseAuthority(candidate: unknown): TerminalAuthorityObservation {
  const value = record(candidate);
  if (value["state"] === "stale" && hasExactKeys(value, ["state"])) {
    return Object.freeze({ state: "stale" });
  }
  if (
    value["state"] === "renewed" &&
    hasExactKeys(value, ["state", "leaseExpiresAt"])
  ) {
    return Object.freeze({
      state: "renewed",
      leaseExpiresAt: z.iso.datetime().parse(value["leaseExpiresAt"]),
    });
  }
  if (
    value["state"] === "uncertain" &&
    ["heartbeat", "revocation", "scheduler"].includes(
      String(value["boundary"]),
    ) &&
    hasExactKeys(value, ["state", "boundary"])
  ) {
    return Object.freeze({
      state: "uncertain",
      boundary: value["boundary"] as "heartbeat" | "revocation" | "scheduler",
    });
  }
  if (
    value["state"] === "cancelled" &&
    hasExactKeys(value, ["state", "cancellation", "termination"])
  ) {
    return deepFreeze({
      state: "cancelled",
      cancellation: runnerCancellationV1Schema.parse(value["cancellation"]),
      termination: sandboxTerminationReceipt(value["termination"]),
    });
  }
  throw new TypeError("Terminal authority observation is invalid.");
}

function noEvidence(
  reason: TerminalOutcomeNoEvidenceReason,
): TerminalOutcomeDecision {
  return Object.freeze({ state: "no_evidence", reason });
}

function evidence(
  drafts: readonly RunnerEventDraft[],
): TerminalOutcomeDecision {
  return deepFreeze({
    state: "evidence",
    drafts: terminalRunnerEventDrafts(drafts),
  });
}

export class TerminalOutcomeArbiter {
  readonly #execution: RunnerExecutionV1;

  constructor(candidate: RunnerExecutionV1) {
    try {
      this.#execution = deepFreeze(runnerExecutionV1Schema.parse(candidate));
    } catch (cause) {
      throw new TerminalOutcomeArbiterError(
        "invalid_input",
        "Terminal outcome execution is invalid.",
        { cause },
      );
    }
  }

  decide(input: {
    timing: TerminalExecutionTiming;
    candidate: TerminalOutcomeCandidate;
    authority: TerminalAuthorityObservation;
  }): TerminalOutcomeDecision {
    let timing: TerminalExecutionTiming;
    let candidate: ParsedCandidate;
    let authority: TerminalAuthorityObservation;
    try {
      const value = record(input);
      if (!hasExactKeys(value, ["timing", "candidate", "authority"])) {
        throw new TypeError("Terminal outcome input has unknown fields.");
      }
      timing = parseTiming(value["timing"]);
      candidate = parseCandidate(value["candidate"]);
      authority = parseAuthority(value["authority"]);
    } catch (cause) {
      throw new TerminalOutcomeArbiterError(
        "invalid_input",
        "Terminal outcome input is invalid.",
        { cause },
      );
    }

    if (authority.state === "stale") {
      return noEvidence("authority_lost");
    }
    if (authority.state === "uncertain") {
      return noEvidence("authority_uncertain");
    }
    if (candidate.state === "runtime" && timing.state === "not_started") {
      return noEvidence("observation_conflict");
    }

    if (authority.state === "cancelled") {
      if (!this.#matches(authority.cancellation)) {
        throw new TerminalOutcomeArbiterError(
          "identity_mismatch",
          "Cancellation authority does not match the terminal outcome execution.",
        );
      }
      if (authority.termination.state === "terminated") {
        if (timing.state === "not_started") {
          return noEvidence("observation_conflict");
        }
        return this.#cancellation(
          authority.cancellation,
          true,
          timing.elapsedMs,
          authority.termination.forced,
        );
      }
      if (candidate.state === "runtime") {
        return evidence(candidate.drafts);
      }
      return this.#cancellation(
        authority.cancellation,
        timing.state === "started",
        timing.state === "started" ? timing.elapsedMs : 0,
        false,
      );
    }

    if (candidate.state === "none") {
      return noEvidence("candidate_missing");
    }
    return evidence(candidate.drafts);
  }

  #matches(cancellation: RunnerCancellationV1): boolean {
    return (
      cancellation.runnerId === this.#execution.lease.runnerId &&
      cancellation.taskId === this.#execution.lease.taskId &&
      cancellation.attemptId === this.#execution.lease.attemptId &&
      cancellation.fence === this.#execution.lease.fence
    );
  }

  #cancellation(
    directive: RunnerCancellationV1,
    executionStarted: boolean,
    elapsedMs: number,
    forced: boolean,
  ): TerminalOutcomeDecision {
    const decision = localFailureEvidence({
      kind: "cancellation",
      directive,
      executionStarted,
      elapsedMs,
      forced,
    });
    if (decision.state !== "evidence") {
      throw new TerminalOutcomeArbiterError(
        "invalid_input",
        "Cancellation policy omitted terminal evidence.",
      );
    }
    return evidence([decision.draft]);
  }
}
