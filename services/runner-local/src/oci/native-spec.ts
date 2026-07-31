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

function caseInsensitiveValue(
  value: JsonObject | undefined,
  expected: string,
): unknown {
  return Object.entries(value ?? {}).find(
    ([name]) => name.toLowerCase() === expected.toLowerCase(),
  )?.[1];
}

function environmentIsSafe(
  environment: readonly string[] | undefined,
): boolean {
  if (!environment || !environment.includes("SOCRATES_SANDBOX=1")) return false;
  const names = environment.map((entry) => entry.slice(0, entry.indexOf("=")));
  if (
    names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    new Set(names).size !== names.length
  ) {
    return false;
  }
  return !names.some((name) =>
    /^(?:ACTIONS_|ANTHROPIC_|AWS_|AZURE_|CI$|DBUS_|DOCKER_|GITHUB_|GOOGLE_|HF_TOKEN$|NPM_TOKEN$|OPENAI_|RUNNER_|SOCRATES_HOST_|SSH_|XDG_RUNTIME_DIR$)/i.test(
      name,
    ),
  );
}

function isOwnedMetadataBind(mount: JsonObject): boolean {
  if (
    !["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(
      String(mount["destination"]),
    )
  ) {
    return false;
  }
  const source = mount["source"];
  return (
    typeof source === "string" &&
    !source.includes("/../") &&
    /^(?:\/run\/user\/\d+\/|\/home\/[^/]+\/\.local\/share\/nerdctl\/)/.test(
      source,
    )
  );
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
  const capabilitiesValue = caseInsensitiveValue(process, "capabilities");
  const capabilities = object(capabilitiesValue);
  const capabilitySets = [
    "bounding",
    "effective",
    "inheritable",
    "permitted",
    "ambient",
  ];
  const capabilityEntries = Object.entries(capabilities ?? {});
  const explicitEmptyObject =
    capabilities !== undefined && capabilityEntries.length === 0;
  const explicitEmptySets =
    capabilities !== undefined &&
    capabilityEntries.length === capabilitySets.length &&
    capabilitySets.every(
      (capabilitySet) =>
        strings(caseInsensitiveValue(capabilities, capabilitySet))?.length ===
        0,
    ) &&
    capabilityEntries.every(([name]) =>
      capabilitySets.includes(name.toLowerCase()),
    );
  if (
    capabilitiesValue === undefined ||
    (!explicitEmptyObject && !explicitEmptySets)
  ) {
    failures.push("process.capabilities");
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
  if (!environmentIsSafe(environment)) {
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
      mounts.some((mount) => {
        const bind =
          mount["type"] === "bind" ||
          strings(mount["options"])?.some((option) =>
            ["bind", "rbind"].includes(option),
          );
        return bind && !isOwnedMetadataBind(mount);
      })
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
  for (const type of ["mount", "pid", "ipc", "cgroup", "network"]) {
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
