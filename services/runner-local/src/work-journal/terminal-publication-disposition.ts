import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import { attemptKeyFor } from "../spool/codec";
import type { SpoolState } from "../spool/contracts";
import type { WorkJournalState } from "./contracts";
import { executionDigestFor } from "./codec";

export interface TerminalDispositionWorkJournal {
  inspect(deliveryId: string): Promise<WorkJournalState | null>;
  claimedExecution(deliveryId: string): Promise<RunnerExecutionV1 | null>;
}

export interface TerminalDispositionSpool {
  inspectExisting(execution: RunnerExecutionV1): Promise<SpoolState | null>;
}

type Cursor = Readonly<{
  acknowledgedSequence: number;
  lastSequence: number;
  pendingEvents: number;
}>;

export type TerminalPublicationDisposition =
  | Readonly<{ state: "absent"; work: WorkJournalState }>
  | Readonly<{ state: "pending"; work: WorkJournalState } & Cursor>
  | Readonly<{ state: "acknowledged"; work: WorkJournalState } & Cursor>
  | Readonly<{ state: "completed"; work: WorkJournalState } & Cursor>;

export class TerminalPublicationDispositionError extends Error {
  constructor(
    readonly code: "identity_conflict" | "invalid_input" | "state_uncertain",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalPublicationDispositionError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableWork(work: WorkJournalState): WorkJournalState {
  return deepFreeze({
    ...work,
    ...(work.completion ? { completion: { ...work.completion } } : {}),
    ...(work.rejection ? { rejection: { ...work.rejection } } : {}),
    ...(work.retirement ? { retirement: { ...work.retirement } } : {}),
  });
}

function active(work: WorkJournalState): boolean {
  return work.state === "claimed" || work.state === "execution_started";
}

function safeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function empty(spool: SpoolState): boolean {
  return (
    !spool.terminal &&
    spool.acknowledgedSequence === 0 &&
    spool.lastSequence === 0 &&
    spool.pendingEvents === 0
  );
}

function cursor(spool: SpoolState): Cursor {
  return Object.freeze({
    acknowledgedSequence: spool.acknowledgedSequence,
    lastSequence: spool.lastSequence,
    pendingEvents: spool.pendingEvents,
  });
}

export class TerminalPublicationDispositionAuditor {
  constructor(
    private readonly journal: TerminalDispositionWorkJournal,
    private readonly spool: TerminalDispositionSpool,
  ) {}

  async audit(
    deliveryInput: string,
    executionInput: RunnerExecutionV1,
  ): Promise<TerminalPublicationDisposition> {
    let deliveryId: string;
    let execution: RunnerExecutionV1;
    try {
      deliveryId =
        runnerTaskDeliveryV1Schema.shape.deliveryId.parse(deliveryInput);
      execution = deepFreeze(runnerExecutionV1Schema.parse(executionInput));
    } catch (cause) {
      throw new TerminalPublicationDispositionError(
        "invalid_input",
        "Publication disposition input is invalid.",
        { cause },
      );
    }

    const work = await this.journal.inspect(deliveryId);
    if (!work) {
      throw new TerminalPublicationDispositionError(
        "state_uncertain",
        "Publication work is absent during disposition audit.",
      );
    }
    if (
      work.deliveryId !== deliveryId ||
      work.taskId !== execution.lease.taskId ||
      work.attemptId !== execution.lease.attemptId
    ) {
      throw new TerminalPublicationDispositionError(
        "identity_conflict",
        "Publication work identity conflicts with the audited execution.",
      );
    }
    if (!active(work) && work.state !== "completed") {
      throw new TerminalPublicationDispositionError(
        "state_uncertain",
        "Publication work is not active or completed during disposition audit.",
      );
    }
    const claimed = await this.journal.claimedExecution(deliveryId);
    if (
      !claimed ||
      executionDigestFor(claimed) !== executionDigestFor(execution)
    ) {
      throw new TerminalPublicationDispositionError(
        "identity_conflict",
        "Publication claim conflicts with the audited execution.",
      );
    }

    const spool = await this.spool.inspectExisting(execution);
    const frozenWork = immutableWork(work);
    if (!spool) {
      if (work.state === "completed") {
        throw new TerminalPublicationDispositionError(
          "state_uncertain",
          "Completed publication work has no terminal spool state.",
        );
      }
      return deepFreeze({ state: "absent", work: frozenWork });
    }
    const expectedAttemptKey = attemptKeyFor(execution);
    if (
      spool.attemptKey !== expectedAttemptKey ||
      !safeCounter(spool.acknowledgedSequence) ||
      !safeCounter(spool.lastSequence) ||
      !safeCounter(spool.pendingEvents)
    ) {
      throw new TerminalPublicationDispositionError(
        "state_uncertain",
        "Publication spool identity or counters are invalid.",
      );
    }
    if (empty(spool)) {
      if (work.state === "completed") {
        throw new TerminalPublicationDispositionError(
          "state_uncertain",
          "Completed publication work has an empty spool.",
        );
      }
      return deepFreeze({ state: "absent", work: frozenWork });
    }
    if (
      !spool.terminal ||
      spool.lastSequence < 1 ||
      spool.acknowledgedSequence > spool.lastSequence ||
      spool.pendingEvents !== spool.lastSequence - spool.acknowledgedSequence
    ) {
      throw new TerminalPublicationDispositionError(
        "state_uncertain",
        "Publication spool does not contain one valid terminal cursor.",
      );
    }
    const counters = cursor(spool);
    if (work.state === "completed") {
      if (
        spool.pendingEvents !== 0 ||
        spool.acknowledgedSequence !== spool.lastSequence ||
        work.completion?.attemptKey !== expectedAttemptKey ||
        work.completion.acknowledgedSequence !== spool.acknowledgedSequence
      ) {
        throw new TerminalPublicationDispositionError(
          "state_uncertain",
          "Completed work conflicts with its terminal acknowledgement.",
        );
      }
      return deepFreeze({ state: "completed", work: frozenWork, ...counters });
    }
    if (spool.pendingEvents > 0) {
      return deepFreeze({ state: "pending", work: frozenWork, ...counters });
    }
    return deepFreeze({
      state: "acknowledged",
      work: frozenWork,
      ...counters,
    });
  }
}
