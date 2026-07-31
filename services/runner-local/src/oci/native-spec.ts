import { sandboxAppArmorProfile, validateSandboxProfile } from "./profile";

import type { SandboxResourceProfile } from "./profile";

type JsonObject = Record<string, unknown>;

export class SandboxInspectionError extends Error {
  constructor(readonly mismatches: readonly string[]) {
    super(`Native OCI inspection mismatch: ${mismatches.join(", ")}.`);
    this.name = "SandboxInspectionError";
  }
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  const values = array(value);
  return values?.every((item) => typeof item === "string")
    ? (values as string[])
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function mountOption(mount: JsonObject | undefined, expected: string): boolean {
  return strings(mount?.["options"])?.includes(expected) === true;
}

function hasSizeOption(mount: JsonObject | undefined, size: number): boolean {
  return (
    strings(mount?.["options"])?.some(
      (option) => option === `size=${size}` || option === `size=${size}b`,
    ) === true
  );
}

export function parseNativeSpec(output: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new SandboxInspectionError(["native inspect returned invalid JSON"]);
  }
  const first = array(parsed)?.[0];
  const spec = object(object(first)?.["Spec"]);
  if (!spec) {
    throw new SandboxInspectionError(["native inspect omitted Spec"]);
  }
  return spec;
}

export function verifyNativeSpec(
  spec: JsonObject,
  profile: SandboxResourceProfile,
): void {
  validateSandboxProfile(profile);
  const failures: string[] = [];
  const process = object(spec["process"]);
  const capabilities = object(process?.["capabilities"]);
  const capabilitySets = [
    "bounding",
    "effective",
    "inheritable",
    "permitted",
    "ambient",
  ];
  for (const capabilitySet of capabilitySets) {
    if (strings(capabilities?.[capabilitySet])?.length !== 0) {
      failures.push(`capabilities.${capabilitySet}`);
    }
  }
  if (process?.["apparmorProfile"] !== sandboxAppArmorProfile) {
    failures.push("process.apparmorProfile");
  }
  if (process?.["noNewPrivileges"] !== true) {
    failures.push("process.noNewPrivileges");
  }
  const user = object(process?.["user"]);
  if (user?.["uid"] !== 65_534 || user["gid"] !== 65_534) {
    failures.push("process.user");
  }
  const environment = strings(process?.["env"]);
  if (environment?.length !== 1 || environment[0] !== "SOCRATES_SANDBOX=1") {
    failures.push("process.env");
  }
  if (object(spec["root"])?.["readonly"] !== true) {
    failures.push("root.readonly");
  }

  const mounts = array(spec["mounts"])
    ?.map(object)
    .filter((mount): mount is JsonObject => mount !== undefined);
  if (!mounts) {
    failures.push("mounts");
  } else {
    if (
      mounts.some(
        (mount) =>
          mount["type"] === "bind" ||
          strings(mount["options"])?.some((option) =>
            ["bind", "rbind"].includes(option),
          ),
      )
    ) {
      failures.push("mounts.bind");
    }
    for (const [destination, size] of [
      ["/workspace", profile.workspaceBytes],
      ["/tmp", profile.temporaryBytes],
      ["/dev/shm", profile.sharedMemoryBytes],
    ] as const) {
      const mount = mounts.find(
        (candidate) => candidate["destination"] === destination,
      );
      if (
        mount?.["type"] !== "tmpfs" ||
        !mountOption(mount, "rw") ||
        !mountOption(mount, "nosuid") ||
        !mountOption(mount, "nodev") ||
        !mountOption(mount, "noexec") ||
        !hasSizeOption(mount, size)
      ) {
        failures.push(`mounts.${destination}`);
      }
    }
  }

  const linux = object(spec["linux"]);
  const namespaceTypes = new Set(
    array(linux?.["namespaces"])
      ?.map(object)
      .map((namespace) => namespace?.["type"])
      .filter((type): type is string => typeof type === "string") ?? [],
  );
  for (const type of ["mount", "pid", "ipc", "user", "cgroup", "network"]) {
    if (!namespaceTypes.has(type)) failures.push(`namespaces.${type}`);
  }

  const resources = object(linux?.["resources"]);
  const memory = object(resources?.["memory"]);
  if (
    memory?.["limit"] !== profile.memoryBytes ||
    memory["swap"] !== profile.memoryBytes
  ) {
    failures.push("resources.memory");
  }
  if (object(resources?.["pids"])?.["limit"] !== profile.maximumPids) {
    failures.push("resources.pids");
  }
  const cpu = object(resources?.["cpu"]);
  const quota = number(cpu?.["quota"]);
  const period = number(cpu?.["period"]);
  if (
    quota === undefined ||
    period === undefined ||
    period <= 0 ||
    Math.abs(quota / period - profile.cpuCount) > 0.000_001
  ) {
    failures.push("resources.cpu");
  }

  const annotations = object(spec["annotations"]);
  if (
    Object.entries(annotations ?? {}).some(
      ([name, value]) =>
        /privileged/i.test(name) && String(value).toLowerCase() === "true",
    )
  ) {
    failures.push("annotations.privileged");
  }

  if (failures.length > 0) {
    throw new SandboxInspectionError(failures);
  }
}
