export type RunnerCapabilityRequirement =
  | {
      kind: "sandbox.oci";
      platform: "linux";
      architecture: "amd64" | "arm64";
    }
  | { kind: "action.command"; shell: false }
  | { kind: "network.egress"; mode: "disabled" | "allowlist" }
  | { kind: "accelerator.nvidia"; maximumDevices: number };

function isCapability(value: unknown): value is RunnerCapabilityRequirement {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;

  const capability = value as Record<string, unknown>;
  switch (capability["kind"]) {
    case "sandbox.oci":
      return (
        capability["platform"] === "linux" &&
        ["amd64", "arm64"].includes(String(capability["architecture"]))
      );
    case "action.command":
      return capability["shell"] === false;
    case "network.egress":
      return ["disabled", "allowlist"].includes(String(capability["mode"]));
    case "accelerator.nvidia":
      return (
        Number.isSafeInteger(capability["maximumDevices"]) &&
        Number(capability["maximumDevices"]) > 0
      );
    default:
      return false;
  }
}

function capabilitySatisfies(
  available: RunnerCapabilityRequirement,
  required: RunnerCapabilityRequirement,
): boolean {
  if (available.kind !== required.kind) return false;

  switch (required.kind) {
    case "sandbox.oci":
      return (
        available.kind === "sandbox.oci" &&
        available.platform === required.platform &&
        available.architecture === required.architecture
      );
    case "action.command":
      return available.kind === "action.command" && !available.shell;
    case "network.egress":
      return (
        available.kind === "network.egress" && available.mode === required.mode
      );
    case "accelerator.nvidia":
      return (
        available.kind === "accelerator.nvidia" &&
        available.maximumDevices >= required.maximumDevices
      );
  }
}

export function runnerSatisfiesCapabilities(
  availableValues: readonly unknown[],
  requiredValues: readonly unknown[],
): boolean {
  if (
    !availableValues.every(isCapability) ||
    !requiredValues.every(isCapability)
  ) {
    return false;
  }

  const availableKinds = new Set(
    availableValues.map((capability) => capability.kind),
  );
  const requiredKinds = new Set(
    requiredValues.map((capability) => capability.kind),
  );
  if (
    availableKinds.size !== availableValues.length ||
    requiredKinds.size !== requiredValues.length
  ) {
    return false;
  }

  return requiredValues.every((required) =>
    availableValues.some((available) =>
      capabilitySatisfies(available, required),
    ),
  );
}
