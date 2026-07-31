import { commandExists, runCommand } from "./process";

import type { CommandResult, EngineFacts, EngineName } from "./types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson(result: CommandResult, description: string): unknown {
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${result.exitCode}.`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${description} returned invalid JSON.`, { cause: error });
  }
}

function desktopOrVm(
  operatingSystem?: string,
  kernelVersion?: string,
): boolean {
  const description =
    `${operatingSystem ?? ""} ${kernelVersion ?? ""}`.toLowerCase();
  return [
    "docker desktop",
    "podman machine",
    "linuxkit",
    "microsoft",
    "wsl",
  ].some((marker) => description.includes(marker));
}

function dockerCompatibleFacts(
  engine: "docker" | "nerdctl",
  rawInfo: unknown,
  rawVersion: unknown,
): EngineFacts {
  const info = object(rawInfo);
  const version = object(rawVersion);
  const client = object(version["Client"]);
  const server = object(version["Server"]);
  const operatingSystem = string(info["OperatingSystem"]);
  const kernelVersion = string(info["KernelVersion"]);
  const securityOptions = stringArray(info["SecurityOptions"]);
  const desktop = desktopOrVm(operatingSystem, kernelVersion);

  return {
    engine,
    available: true,
    clientVersion: string(client["Version"]) ?? string(version["Version"]),
    serverVersion:
      string(server["Version"]) ??
      string(info["ServerVersion"]) ??
      string(version["Version"]),
    operatingSystem,
    architecture: string(info["Architecture"]),
    kernelVersion,
    cgroupVersion: string(info["CgroupVersion"])?.replace(/^v/, ""),
    cgroupDriver: string(info["CgroupDriver"]),
    storageDriver: string(info["Driver"]),
    securityOptions,
    nativeLinux: string(info["OSType"]) === "linux" && !desktop,
    rootless: securityOptions.some((option) =>
      option.toLowerCase().includes("rootless"),
    ),
    desktopOrVm: desktop,
  };
}

function podmanFacts(rawInfo: unknown, rawVersion: unknown): EngineFacts {
  const info = object(rawInfo);
  const host = object(info["host"]);
  const security = object(host["security"]);
  const store = object(info["store"]);
  const embeddedVersion = object(info["version"]);
  const version = object(rawVersion);
  const client = object(version["Client"]);
  const server = object(version["Server"]);
  const operatingSystem = string(host["os"]);
  const kernelVersion = string(host["kernel"]);
  const securityOptions = [
    ...(boolean(security["seccompEnabled"]) ? ["name=seccomp"] : []),
    ...(boolean(security["apparmorEnabled"]) ? ["name=apparmor"] : []),
    ...(boolean(security["selinuxEnabled"]) ? ["name=selinux"] : []),
    ...(boolean(security["rootless"]) ? ["name=rootless"] : []),
  ];
  const desktop = desktopOrVm(operatingSystem, kernelVersion);

  return {
    engine: "podman",
    available: true,
    clientVersion:
      string(client["Version"]) ??
      string(version["Version"]) ??
      string(embeddedVersion["Version"]) ??
      string(embeddedVersion["version"]),
    serverVersion:
      string(server["Version"]) ??
      string(version["Version"]) ??
      string(embeddedVersion["Version"]) ??
      string(embeddedVersion["version"]),
    operatingSystem,
    architecture: string(host["arch"]),
    kernelVersion,
    cgroupVersion: string(host["cgroupVersion"])?.replace(/^v/, ""),
    cgroupDriver: string(host["cgroupManager"]),
    storageDriver: string(store["graphDriverName"]),
    securityOptions,
    nativeLinux: operatingSystem === "linux" && !desktop,
    rootless: boolean(security["rootless"]),
    desktopOrVm: desktop,
  };
}

export function parseEngineFacts(
  engine: EngineName,
  rawInfo: unknown,
  rawVersion: unknown,
): EngineFacts {
  return engine === "podman"
    ? podmanFacts(rawInfo, rawVersion)
    : dockerCompatibleFacts(engine, rawInfo, rawVersion);
}

export function unavailableEngineFacts(engine: EngineName): EngineFacts {
  return {
    engine,
    available: false,
    securityOptions: [],
    nativeLinux: false,
    rootless: false,
    desktopOrVm: false,
  };
}

export async function readEngineFacts(
  engine: EngineName,
): Promise<EngineFacts> {
  if (!(await commandExists(engine))) return unavailableEngineFacts(engine);

  const [infoResult, versionResult] = await Promise.all([
    runCommand(engine, ["info", "--format", "{{json .}}"]),
    runCommand(engine, ["version", "--format", "{{json .}}"]),
  ]);
  if (infoResult.exitCode !== 0 || versionResult.exitCode !== 0) {
    return unavailableEngineFacts(engine);
  }
  return parseEngineFacts(
    engine,
    parseJson(infoResult, `${engine} info`),
    parseJson(versionResult, `${engine} version`),
  );
}
