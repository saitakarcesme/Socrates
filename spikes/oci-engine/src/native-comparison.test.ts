import { describe, expect, it } from "vitest";

import { buildNativeComparison } from "./native-comparison";
import { sandboxProfile } from "./profile";

import type { EngineName, NativeEngineOutcome, SpikeEvidence } from "./types";

const image = `node@sha256:${"a".repeat(64)}`;

function evidence(
  engine: EngineName,
  overrides: Partial<SpikeEvidence> = {},
): SpikeEvidence {
  return {
    schemaVersion: "1",
    spikeId: `${engine}-spike`,
    recordedAt: "2026-07-31T00:00:00.000Z",
    image,
    profile: sandboxProfile,
    facts: {
      engine,
      available: true,
      architecture: "amd64",
      kernelVersion: "6.8.0-57-generic",
      cgroupVersion: "2",
      securityOptions: ["name=rootless", "name=seccomp", "name=apparmor"],
      nativeLinux: true,
      rootless: true,
      desktopOrVm: false,
    },
    preflight: [],
    adversarial: [],
    cancellation: [],
    cleanup: [],
    latency: {
      runAndRemove: {
        samples: 30,
        medianMs: 100,
        p95Ms: 120,
        maximumMs: 130,
      },
    },
    eligibleForNativeSelection: true,
    limitations: [],
    ...overrides,
  };
}

function comparison(outcomes: readonly NativeEngineOutcome[]) {
  return buildNativeComparison({
    sessionId: "native-session",
    recordedAt: "2026-07-31T00:00:00.000Z",
    image,
    outcomes,
  });
}

function unavailableNerdctl(): SpikeEvidence {
  const value = evidence("nerdctl");
  return {
    ...value,
    facts: {
      ...value.facts,
      available: false,
      nativeLinux: false,
      rootless: false,
    },
    eligibleForNativeSelection: false,
  };
}

function reviewableOutcomes(
  input: {
    docker?: SpikeEvidence;
    podman?: SpikeEvidence;
  } = {},
): NativeEngineOutcome[] {
  return [
    {
      engine: "docker",
      evidenceFile: "docker.json",
      evidence: input.docker ?? evidence("docker"),
    },
    {
      engine: "podman",
      evidenceFile: "podman.json",
      evidence: input.podman ?? evidence("podman"),
    },
    {
      engine: "nerdctl",
      evidenceFile: "nerdctl.json",
      evidence: unavailableNerdctl(),
    },
  ];
}

describe("native OCI comparison manifest", () => {
  it("marks comparable eligible required candidates review-ready", () => {
    const result = comparison(reviewableOutcomes());

    expect(result.readyForArchitectureReview).toBe(true);
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
    expect(result.results).toHaveLength(3);
  });

  it("fails closed when required evidence is missing", () => {
    const result = comparison([
      {
        engine: "docker",
        evidenceFile: "docker.json",
        evidence: evidence("docker"),
      },
      { engine: "podman", failureCode: "execution-error" },
      {
        engine: "nerdctl",
        evidenceFile: "nerdctl.json",
        evidence: evidence("nerdctl"),
      },
    ]);

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find((gate) => gate.name === "required candidate evidence"),
    ).toMatchObject({ passed: false });
  });

  it("rejects evidence from different host identities", () => {
    const podman = evidence("podman");
    const result = comparison(
      reviewableOutcomes({
        podman: {
          ...podman,
          facts: { ...podman.facts, kernelVersion: "6.9.0-different" },
        },
      }),
    );

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find((gate) => gate.name === "reference host identity"),
    ).toMatchObject({ passed: false });
  });

  it("rejects different sandbox profiles", () => {
    const podman = evidence("podman");
    const result = comparison(
      reviewableOutcomes({
        podman: {
          ...podman,
          profile: { ...podman.profile, maximumPids: 31 },
        },
      }),
    );

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find((gate) => gate.name === "fixed input comparability"),
    ).toMatchObject({ passed: false });
  });

  it("rejects different latency sample counts", () => {
    const podman = evidence("podman");
    const result = comparison(
      reviewableOutcomes({
        podman: {
          ...podman,
          latency: {
            runAndRemove: {
              ...podman.latency!.runAndRemove,
              samples: 29,
            },
          },
        },
      }),
    );

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find((gate) => gate.name === "latency sample comparability"),
    ).toMatchObject({ passed: false });
  });

  it("rejects a complete but ineligible required candidate", () => {
    const podman = evidence("podman", {
      eligibleForNativeSelection: false,
    });
    const result = comparison(reviewableOutcomes({ podman }));

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find(
        (gate) => gate.name === "required candidate eligibility",
      ),
    ).toMatchObject({ passed: false });
  });

  it("does not hide an optional candidate execution failure", () => {
    const outcomes = reviewableOutcomes();
    outcomes[2] = { engine: "nerdctl", failureCode: "execution-error" };
    const result = comparison(outcomes);

    expect(result.readyForArchitectureReview).toBe(false);
    expect(
      result.gates.find(
        (gate) => gate.name === "optional candidate disposition",
      ),
    ).toMatchObject({ passed: false });
  });
});
