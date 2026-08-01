import type {
  LeaseAuthorityCheckpointResult,
  LeaseAuthorityResult,
} from "../supervision/lease-authority-monitor";
import {
  type TerminalEvidencePublicationResult,
  TerminalEvidencePublicationDeferredError,
} from "./terminal-evidence-publication";
import {
  TerminalPublicationAuthorityPolicy,
  type TerminalPublicationSettlement,
} from "./terminal-publication-authority-policy";
import type { TerminalPublicationDisposition } from "./terminal-publication-disposition";

export interface TerminalPublicationAuthorityOwnerPort {
  checkpoint(): Promise<LeaseAuthorityCheckpointResult>;
  stop(): Promise<LeaseAuthorityResult>;
  abandonPublication(): Promise<LeaseAuthorityResult>;
}

type CompletedAuthorityResult = Extract<
  LeaseAuthorityResult,
  Readonly<{ state: "cancelled" | "stale" | "stopped" }>
>;

export type TerminalPublicationOwnershipResult = Readonly<{
  state: "completed";
  publication: TerminalEvidencePublicationResult;
  authority: CompletedAuthorityResult;
}>;

type ErrorEvidence = Readonly<{
  authority?: LeaseAuthorityResult;
  disposition?: TerminalPublicationDisposition;
  publication?: TerminalEvidencePublicationResult;
}>;

export class TerminalPublicationOwnerError extends Error {
  readonly authority?: LeaseAuthorityResult;
  readonly disposition?: TerminalPublicationDisposition;
  readonly publication?: TerminalEvidencePublicationResult;

  constructor(
    readonly code:
      | "authority_checkpoint_terminal"
      | "authority_checkpoint_uncertain"
      | "authority_terminal"
      | "completion_release_uncertain"
      | "disposition_regressed"
      | "publication_abandoned"
      | "recovery_exhausted"
      | "release_conflict"
      | "release_uncertain",
    message: string,
    evidence: ErrorEvidence = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalPublicationOwnerError";
    if (evidence.authority) {
      this.authority = immutable(evidence.authority);
    }
    if (evidence.disposition) {
      this.disposition = immutable(evidence.disposition);
    }
    if (evidence.publication) {
      this.publication = immutable(evidence.publication);
    }
    Object.freeze(this);
  }
}

type RetainedDisposition = Extract<
  TerminalPublicationDisposition,
  Readonly<{ state: "acknowledged" | "pending" }>
>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutable<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function checkpointResult(
  value: LeaseAuthorityCheckpointResult,
): value is LeaseAuthorityCheckpointResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value.state === "renewed" ||
      value.state === "cancelled" ||
      value.state === "stale")
  );
}

function completedAuthorityResult(
  value: LeaseAuthorityResult,
): value is CompletedAuthorityResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value.state === "stopped" ||
      value.state === "cancelled" ||
      value.state === "stale")
  );
}

function sameWork(
  left: RetainedDisposition,
  right: RetainedDisposition,
): boolean {
  return (
    left.work.deliveryId === right.work.deliveryId &&
    left.work.taskId === right.work.taskId &&
    left.work.attemptId === right.work.attemptId
  );
}

function progresses(
  previous: RetainedDisposition,
  current: RetainedDisposition,
): boolean {
  const acknowledgedDelta =
    current.acknowledgedSequence - previous.acknowledgedSequence;
  const pendingDelta = previous.pendingEvents - current.pendingEvents;
  return (
    sameWork(previous, current) &&
    current.lastSequence === previous.lastSequence &&
    acknowledgedDelta >= 0 &&
    pendingDelta >= 0 &&
    acknowledgedDelta === pendingDelta
  );
}

function retained(
  reason: TerminalEvidencePublicationDeferredError,
): RetainedDisposition {
  const disposition = reason.disposition;
  if (disposition.state !== "pending" && disposition.state !== "acknowledged") {
    throw new TypeError("Publication policy retained a non-retainable state.");
  }
  return disposition;
}

export class TerminalPublicationOwner {
  readonly #authority: TerminalPublicationAuthorityOwnerPort;
  readonly #maximumRecoveryAttempts: number;
  readonly #policy = new TerminalPublicationAuthorityPolicy();
  readonly #publish: () => Promise<TerminalEvidencePublicationResult>;
  #operation: Promise<TerminalPublicationOwnershipResult> | undefined;

  constructor(options: {
    authority: TerminalPublicationAuthorityOwnerPort;
    maximumRecoveryAttempts: number;
    publish: () => Promise<TerminalEvidencePublicationResult>;
  }) {
    if (
      !Number.isSafeInteger(options.maximumRecoveryAttempts) ||
      options.maximumRecoveryAttempts < 0 ||
      options.maximumRecoveryAttempts > 100
    ) {
      throw new RangeError(
        "maximumRecoveryAttempts must be a safe integer between 0 and 100.",
      );
    }
    this.#authority = options.authority;
    this.#maximumRecoveryAttempts = options.maximumRecoveryAttempts;
    this.#publish = options.publish;
  }

  complete(): Promise<TerminalPublicationOwnershipResult> {
    this.#operation ??= this.#complete();
    return this.#operation;
  }

  async #complete(): Promise<TerminalPublicationOwnershipResult> {
    let recoveryAttempts = 0;
    let previous: RetainedDisposition | undefined;
    while (true) {
      const settlement = await this.#settlePublication();
      let decision;
      try {
        decision = this.#policy.decide(settlement);
      } catch (policyCause) {
        const publicationCause =
          settlement.status === "rejected"
            ? new AggregateError([settlement.reason, policyCause])
            : policyCause;
        return this.#abandon(
          "publication_abandoned",
          "Terminal publication settlement is not recoverable.",
          publicationCause,
        );
      }

      if (decision.state === "stop") {
        if (settlement.status !== "fulfilled") {
          return this.#abandon(
            "publication_abandoned",
            "Terminal publication policy produced an invalid stop decision.",
            settlement.reason,
          );
        }
        return this.#completeRelease(settlement.value);
      }
      if (decision.state === "abandon") {
        if (settlement.status !== "rejected") {
          return this.#abandon(
            "publication_abandoned",
            "Terminal publication policy produced an invalid abandon decision.",
            new TypeError("Fulfilled publication selected abandonment."),
          );
        }
        return this.#abandon(
          "publication_abandoned",
          "Terminal publication was abandoned.",
          settlement.reason,
          settlement.reason instanceof TerminalEvidencePublicationDeferredError
            ? settlement.reason.disposition
            : undefined,
        );
      }

      if (settlement.status !== "rejected") {
        return this.#abandon(
          "publication_abandoned",
          "Terminal publication policy produced an invalid retain decision.",
          new TypeError("Fulfilled publication selected retention."),
        );
      }
      const reason = settlement.reason;
      if (!(reason instanceof TerminalEvidencePublicationDeferredError)) {
        return this.#abandon(
          "publication_abandoned",
          "Terminal publication retention is invalid.",
          reason,
        );
      }
      const current = retained(reason);
      if (previous && !progresses(previous, current)) {
        return this.#abandon(
          "disposition_regressed",
          "Terminal publication disposition regressed.",
          reason,
          current,
        );
      }
      previous = immutable(current);

      if (recoveryAttempts >= this.#maximumRecoveryAttempts) {
        return this.#abandon(
          "recovery_exhausted",
          "Terminal publication recovery attempts were exhausted.",
          reason,
          current,
        );
      }
      if (current.state === "pending") {
        let checkpoint: LeaseAuthorityCheckpointResult;
        try {
          checkpoint = await this.#authority.checkpoint();
        } catch (checkpointCause) {
          throw new TerminalPublicationOwnerError(
            "authority_checkpoint_uncertain",
            "Lease authority checkpoint failed during publication recovery.",
            { disposition: current },
            { cause: new AggregateError([reason, checkpointCause]) },
          );
        }
        if (!checkpointResult(checkpoint)) {
          throw new TerminalPublicationOwnerError(
            "authority_checkpoint_uncertain",
            "Lease authority checkpoint returned an invalid result.",
            { disposition: current },
            {
              cause: new AggregateError([
                reason,
                new TypeError("Invalid lease authority checkpoint result."),
              ]),
            },
          );
        }
        if (checkpoint.state !== "renewed") {
          throw new TerminalPublicationOwnerError(
            "authority_checkpoint_terminal",
            "Lease authority ended before publication recovery.",
            { authority: checkpoint, disposition: current },
            { cause: reason },
          );
        }
      }
      recoveryAttempts += 1;
    }
  }

  async #settlePublication(): Promise<TerminalPublicationSettlement> {
    try {
      return { status: "fulfilled", value: await this.#publish() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  }

  async #completeRelease(
    publication: TerminalEvidencePublicationResult,
  ): Promise<TerminalPublicationOwnershipResult> {
    let authority: LeaseAuthorityResult;
    try {
      authority = await this.#authority.stop();
    } catch (releaseCause) {
      throw new TerminalPublicationOwnerError(
        "completion_release_uncertain",
        "Lease authority release is uncertain after durable publication.",
        { publication },
        { cause: releaseCause },
      );
    }
    if (!completedAuthorityResult(authority)) {
      throw new TerminalPublicationOwnerError(
        "release_conflict",
        "Lease authority did not complete clean release.",
        { authority, publication },
      );
    }
    return immutable({ state: "completed", publication, authority });
  }

  async #abandon(
    code:
      "disposition_regressed" | "publication_abandoned" | "recovery_exhausted",
    message: string,
    publicationCause: unknown,
    disposition?: TerminalPublicationDisposition,
  ): Promise<never> {
    let authority: LeaseAuthorityResult;
    try {
      authority = await this.#authority.abandonPublication();
    } catch (releaseCause) {
      throw new TerminalPublicationOwnerError(
        "release_uncertain",
        "Lease authority abandonment is uncertain.",
        disposition ? { disposition } : {},
        { cause: new AggregateError([publicationCause, releaseCause]) },
      );
    }
    if (authority.state === "stopped") {
      throw new TerminalPublicationOwnerError(
        "release_conflict",
        "Lease authority stopped before publication abandonment.",
        { authority, ...(disposition ? { disposition } : {}) },
        { cause: publicationCause },
      );
    }
    if (authority.state === "cancelled" || authority.state === "stale") {
      throw new TerminalPublicationOwnerError(
        "authority_terminal",
        "Lease authority ended during publication abandonment.",
        { authority, ...(disposition ? { disposition } : {}) },
        { cause: publicationCause },
      );
    }
    if (authority.state !== "abandoned") {
      throw new TerminalPublicationOwnerError(
        "release_conflict",
        "Lease authority returned an invalid abandonment result.",
        { authority, ...(disposition ? { disposition } : {}) },
        { cause: publicationCause },
      );
    }
    throw new TerminalPublicationOwnerError(
      code,
      message,
      { authority, ...(disposition ? { disposition } : {}) },
      { cause: publicationCause },
    );
  }
}
