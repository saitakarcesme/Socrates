import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canTransitionRunnerTask,
  classifyRunnerEventSequence,
  type RunnerTaskStatus,
} from "./runner-task";

const statuses: readonly RunnerTaskStatus[] = [
  "queued",
  "leased",
  "running",
  "cancellation_requested",
  "succeeded",
  "failed",
  "cancelled",
];

describe("runner task lifecycle", () => {
  it("makes every terminal state immutable", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("succeeded", "failed", "cancelled"),
        fc.constantFrom(...statuses),
        (terminal, candidate) => {
          expect(
            canTransitionRunnerTask(
              terminal as RunnerTaskStatus,
              candidate as RunnerTaskStatus,
            ),
          ).toBe(false);
        },
      ),
    );
  });

  it("allows a cancellation race to resolve once through a terminal CAS", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      expect(canTransitionRunnerTask("cancellation_requested", terminal)).toBe(
        true,
      );
    }
    expect(canTransitionRunnerTask("cancellation_requested", "running")).toBe(
      false,
    );
  });
});

describe("runner event sequence", () => {
  it("accepts only the immediate successor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 2 }),
        (lastAcknowledged) => {
          expect(
            classifyRunnerEventSequence(lastAcknowledged, lastAcknowledged + 1),
          ).toEqual({
            kind: "accepted",
            acknowledgedSequence: lastAcknowledged + 1,
          });
        },
      ),
    );
  });

  it("classifies earlier sequences as replays and later sequences as gaps", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (lastAcknowledged, incoming) => {
          const result = classifyRunnerEventSequence(
            lastAcknowledged,
            incoming,
          );
          if (incoming <= lastAcknowledged) {
            expect(result.kind).toBe("replay");
          } else if (incoming === lastAcknowledged + 1) {
            expect(result.kind).toBe("accepted");
          } else {
            expect(result.kind).toBe("gap");
          }
        },
      ),
    );
  });

  it("rejects a cursor that has no safe integer successor", () => {
    expect(() =>
      classifyRunnerEventSequence(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(RangeError);
  });
});
