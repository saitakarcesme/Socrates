import type {
  EngineName,
  GateResult,
  NativeComparisonManifest,
  NativeEngineOutcome,
  SpikeEvidence,
} from "./types";

export const requiredNativeEngines = ["docker", "podman"] as const;
export const optionalNativeEngines = ["nerdctl"] as const;

function evidenceFor(
  outcomes: readonly NativeEngineOutcome[],
  engine: EngineName,
): SpikeEvidence | undefined {
  return outcomes.find((outcome) => outcome.engine === engine)?.evidence;
}

function sameDefinedValue(
  evidence: readonly SpikeEvidence[],
  select: (value: SpikeEvidence) => string | undefined,
): boolean {
  const values = evidence.map(select);
  return values.every((value) => value !== undefined && value === values.at(0));
}

function gate(name: string, passed: boolean, detail: string): GateResult {
  return { name, passed, detail };
}

export function buildNativeComparison(input: {
  sessionId: string;
  recordedAt: string;
  image: string;
  outcomes: readonly NativeEngineOutcome[];
}): NativeComparisonManifest {
  const requiredEvidence = requiredNativeEngines
    .map((engine) => evidenceFor(input.outcomes, engine))
    .filter((evidence): evidence is SpikeEvidence => evidence !== undefined);
  const requiredComplete =
    requiredEvidence.length === requiredNativeEngines.length;
  const requiredEligible =
    requiredComplete &&
    requiredEvidence.every((evidence) => evidence.eligibleForNativeSelection);
  const sameImageAndProfile =
    requiredComplete &&
    requiredEvidence.every((evidence) => evidence.image === input.image) &&
    requiredEvidence.every(
      (evidence) =>
        JSON.stringify(evidence.profile) ===
        JSON.stringify(requiredEvidence[0]?.profile),
    );
  const sameHost =
    requiredComplete &&
    sameDefinedValue(
      requiredEvidence,
      (evidence) => evidence.facts.kernelVersion,
    ) &&
    sameDefinedValue(
      requiredEvidence,
      (evidence) => evidence.facts.architecture,
    ) &&
    sameDefinedValue(
      requiredEvidence,
      (evidence) => evidence.facts.cgroupVersion,
    );
  const comparableLatency =
    requiredComplete &&
    requiredEvidence.every(
      (evidence) =>
        evidence.latency?.runAndRemove.samples !== undefined &&
        evidence.latency.runAndRemove.samples > 0 &&
        evidence.latency.runAndRemove.samples ===
          requiredEvidence[0]?.latency?.runAndRemove.samples,
    );
  const optionalDispositionRecorded = optionalNativeEngines.every(
    (engine) => evidenceFor(input.outcomes, engine) !== undefined,
  );
  const gates = [
    gate(
      "required candidate evidence",
      requiredComplete,
      requiredComplete
        ? "Docker and Podman produced complete evidence"
        : "Docker or Podman evidence is missing",
    ),
    gate(
      "required candidate eligibility",
      requiredEligible,
      requiredEligible
        ? "Docker and Podman passed every native selection gate"
        : "Docker or Podman is not eligible for native selection",
    ),
    gate(
      "fixed input comparability",
      sameImageAndProfile,
      sameImageAndProfile
        ? "required candidates used the same image and sandbox profile"
        : "required candidate image or sandbox profile differs",
    ),
    gate(
      "reference host identity",
      sameHost,
      sameHost
        ? "required candidates report the same kernel, architecture, and cgroup version"
        : "required candidate host identity is missing or differs",
    ),
    gate(
      "latency sample comparability",
      comparableLatency,
      comparableLatency
        ? "required candidates report equal non-empty latency sample counts"
        : "required candidate latency samples are missing or differ",
    ),
    gate(
      "optional candidate disposition",
      optionalDispositionRecorded,
      optionalDispositionRecorded
        ? "every optional candidate produced evidence or an unavailable fact record"
        : "an optional candidate failed before its disposition was recorded",
    ),
  ];

  const results = input.outcomes.map((outcome) => ({
    engine: outcome.engine,
    status: outcome.evidence ? ("complete" as const) : ("failed" as const),
    ...(outcome.evidenceFile
      ? { evidenceFile: outcome.evidenceFile }
      : undefined),
    eligibleForNativeSelection:
      outcome.evidence?.eligibleForNativeSelection ?? false,
    availability: outcome.evidence
      ? outcome.evidence.facts.available
        ? ("available" as const)
        : ("unavailable" as const)
      : ("unknown" as const),
    ...(outcome.evidence?.latency?.runAndRemove
      ? { latency: outcome.evidence.latency.runAndRemove }
      : undefined),
    ...(outcome.failureCode ? { failureCode: outcome.failureCode } : undefined),
  }));

  return {
    schemaVersion: "1",
    sessionId: input.sessionId,
    recordedAt: input.recordedAt,
    image: input.image,
    requiredEngines: requiredNativeEngines,
    optionalEngines: optionalNativeEngines,
    results,
    gates,
    readyForArchitectureReview: gates.every((result) => result.passed),
  };
}
