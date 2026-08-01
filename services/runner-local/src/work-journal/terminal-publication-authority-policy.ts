import {
  TerminalEvidencePublicationDeferredError,
  type TerminalEvidencePublicationResult,
} from "./terminal-evidence-publication";

export type TerminalPublicationSettlement =
  | Readonly<{
      status: "fulfilled";
      value: TerminalEvidencePublicationResult;
    }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

export type TerminalPublicationAuthorityDecision = Readonly<{
  state: "abandon" | "retain" | "stop";
}>;

export class TerminalPublicationAuthorityPolicyError extends Error {
  constructor(
    readonly code: "impossible_disposition" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "TerminalPublicationAuthorityPolicyError";
  }
}

const abandon = Object.freeze({ state: "abandon" as const });
const retain = Object.freeze({ state: "retain" as const });
const stop = Object.freeze({ state: "stop" as const });

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function completed(value: unknown): value is TerminalEvidencePublicationResult {
  return (
    object(value) &&
    value.state === "completed" &&
    (value.publication === "appended" || value.publication === "recovered") &&
    object(value.work)
  );
}

export class TerminalPublicationAuthorityPolicy {
  decide(
    settlement: TerminalPublicationSettlement,
  ): TerminalPublicationAuthorityDecision {
    if (!object(settlement)) {
      throw new TerminalPublicationAuthorityPolicyError(
        "invalid_input",
        "Terminal publication settlement is invalid.",
      );
    }
    if (settlement.status === "fulfilled") {
      if (!completed(settlement.value)) {
        throw new TerminalPublicationAuthorityPolicyError(
          "invalid_input",
          "Fulfilled terminal publication settlement is invalid.",
        );
      }
      return stop;
    }
    if (settlement.status !== "rejected") {
      throw new TerminalPublicationAuthorityPolicyError(
        "invalid_input",
        "Terminal publication settlement status is invalid.",
      );
    }

    const reason = settlement.reason;
    if (!(reason instanceof TerminalEvidencePublicationDeferredError)) {
      return abandon;
    }
    const dispositionState = object(reason.disposition)
      ? reason.disposition.state
      : undefined;
    if (dispositionState === "pending" || dispositionState === "acknowledged") {
      return retain;
    }
    if (dispositionState === "completed") {
      throw new TerminalPublicationAuthorityPolicyError(
        "impossible_disposition",
        "Completed publication cannot be deferred.",
      );
    }
    return abandon;
  }
}
