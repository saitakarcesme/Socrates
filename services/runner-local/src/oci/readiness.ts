import { readFile } from "node:fs/promises";

import type { ProcessExecutor, ProcessResult } from "./process";

type JsonObject = Record<string, unknown>;

export type HostReadinessProbe = Readonly<{
  platform: NodeJS.Platform;
  uid: number | undefined;
  cgroupControllers: readonly string[];
  appArmorEnabled: boolean;
}>;

export type SandboxReadiness = Readonly<{
  checkedAt: string;
  nerdctlVersion: string;
  serverVersion: string;
  architecture: "amd64" | "arm64";
  cgroupVersion: "2";
  securityOptions: readonly string[];
}>;

export interface HostReadinessInspector {
  inspect(): Promise<HostReadinessProbe>;
}

export interface ReadinessVerifier {
  verify(): Promise<SandboxReadiness>;
}

export class SandboxReadinessError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`OCI backend is not ready: ${failures.join(", ")}.`);
    this.name = "SandboxReadinessError";
  }
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function architecture(value: unknown): "amd64" | "arm64" | undefined {
  const reported = string(value)?.toLowerCase();
  if (reported === "amd64" || reported === "x86_64" || reported === "x64") {
    return "amd64";
  }
  if (reported === "arm64" || reported === "aarch64") return "arm64";
  return undefined;
}

function parseJson(result: ProcessResult, name: string): JsonObject {
  if (result.exitCode !== 0) {
    throw new SandboxReadinessError([`${name} exited ${result.exitCode}`]);
  }
  try {
    return object(JSON.parse(result.stdout) as unknown);
  } catch {
    throw new SandboxReadinessError([`${name} returned invalid JSON`]);
  }
}

async function readable(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export class NodeHostReadinessInspector implements HostReadinessInspector {
  async inspect(): Promise<HostReadinessProbe> {
    const [controllers, appArmorEnabled] = await Promise.all([
      readable("/sys/fs/cgroup/cgroup.controllers"),
      readable("/sys/module/apparmor/parameters/enabled"),
    ]);
    return {
      platform: process.platform,
      uid: process.getuid?.(),
      cgroupControllers: controllers.trim().split(/\s+/).filter(Boolean),
      appArmorEnabled: appArmorEnabled.trim().toLowerCase() === "y",
    };
  }
}

export type ReadinessVerifierOptions = Readonly<{
  executable?: string;
  timeoutMs?: number;
  maximumOutputBytes?: number;
  now?: () => Date;
}>;

export class NerdctlReadinessVerifier implements ReadinessVerifier {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maximumOutputBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly processes: ProcessExecutor,
    private readonly host: HostReadinessInspector,
    options: ReadinessVerifierOptions = {},
  ) {
    this.executable = options.executable ?? "nerdctl";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumOutputBytes = options.maximumOutputBytes ?? 256 * 1_024;
    this.now = options.now ?? (() => new Date());
  }

  private run(arguments_: readonly string[]): Promise<ProcessResult> {
    return this.processes.run({
      executable: this.executable,
      arguments: arguments_,
      timeoutMs: this.timeoutMs,
      maximumOutputBytes: this.maximumOutputBytes,
    });
  }

  async verify(): Promise<SandboxReadiness> {
    const [host, versionResult, infoResult, inspectHelp] = await Promise.all([
      this.host.inspect(),
      this.run(["version", "--format", "{{json .}}"]),
      this.run(["info", "--format", "{{json .}}"]),
      this.run(["inspect", "--help"]),
    ]);
    const version = parseJson(versionResult, "nerdctl version");
    const info = parseJson(infoResult, "nerdctl info");
    const clientVersion =
      string(object(version["Client"])["Version"]) ??
      string(version["Version"]);
    const serverVersion =
      string(object(version["Server"])["Version"]) ??
      string(info["ServerVersion"]);
    const securityOptions = strings(info["SecurityOptions"]);
    const hostArchitecture = architecture(info["Architecture"]);
    const failures: string[] = [];

    if (host.platform !== "linux") failures.push("host is not Linux");
    if (host.uid === undefined || host.uid === 0)
      failures.push("runner is not unprivileged");
    if (!clientVersion || !/^v?2\.3\.\d+(?:[-+].*)?$/.test(clientVersion))
      failures.push("nerdctl is not in the selected 2.3.x family");
    if (!serverVersion) failures.push("containerd server version is absent");
    if (!hostArchitecture) failures.push("host architecture is unsupported");
    if (String(info["CgroupVersion"]).replace(/^v/, "") !== "2")
      failures.push("cgroup v2 is absent");
    for (const controller of ["cpu", "memory", "pids"]) {
      if (!host.cgroupControllers.includes(controller))
        failures.push(`${controller} cgroup controller is absent`);
    }
    if (
      !securityOptions.some((option) =>
        option.toLowerCase().includes("rootless"),
      )
    ) {
      failures.push("containerd is not rootless");
    }
    if (
      !securityOptions.some((option) =>
        option.toLowerCase().includes("seccomp"),
      )
    ) {
      failures.push("seccomp is absent");
    }
    if (!host.appArmorEnabled) failures.push("AppArmor is disabled");
    if (
      inspectHelp.exitCode !== 0 ||
      !inspectHelp.stdout.includes("--mode") ||
      !inspectHelp.stdout.includes("native")
    ) {
      failures.push("native OCI inspection is unavailable");
    }
    if (failures.length > 0) throw new SandboxReadinessError(failures);

    return Object.freeze({
      checkedAt: this.now().toISOString(),
      nerdctlVersion: clientVersion!.replace(/^v/, ""),
      serverVersion: serverVersion!,
      architecture: hostArchitecture!,
      cgroupVersion: "2",
      securityOptions: Object.freeze([...securityOptions]),
    });
  }
}
