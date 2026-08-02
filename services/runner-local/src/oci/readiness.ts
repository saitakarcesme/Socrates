import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { posix } from "node:path";

import type { NerdctlInvocation } from "./invocation";
import type { ProcessExecutor, ProcessResult } from "./process";

type JsonObject = Record<string, unknown>;

export const nerdctlConfigurationBytes =
  "# Managed by Socrates. Intentionally empty.\n";
export const nerdctlConfigurationSha256 =
  "455193711f3d711e4499f8875cdd65ed6f4c50cb3a7812bad3d181a280ad58cd";

export type HostPathAttestation = Readonly<{
  path: string;
  kind: "directory" | "file" | "missing" | "other";
  ownerUid: number | undefined;
  mode: number | undefined;
  symlinkFree: boolean;
}>;

export type HostReadinessProbe = Readonly<{
  platform: NodeJS.Platform;
  uid: number | undefined;
  cgroupControllers: readonly string[];
  appArmorEnabled: boolean;
  engineConfiguration: HostPathAttestation &
    Readonly<{
      sha256: string | undefined;
      exactBytes: boolean;
    }>;
  xdgRuntimeDirectory: HostPathAttestation;
  rootlessKitStateDirectory: HostPathAttestation;
  workingDirectory: HostPathAttestation;
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

async function pathAttestation(path: string): Promise<HostPathAttestation> {
  let symlinkFree = true;
  let cursor = "/";
  for (const component of path.split("/").filter(Boolean)) {
    cursor = posix.join(cursor, component);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) symlinkFree = false;
    } catch {
      return {
        path,
        kind: "missing",
        ownerUid: undefined,
        mode: undefined,
        symlinkFree,
      };
    }
  }
  try {
    const metadata = await lstat(path);
    return {
      path,
      kind: metadata.isFile()
        ? "file"
        : metadata.isDirectory()
          ? "directory"
          : "other",
      ownerUid: metadata.uid,
      mode: metadata.mode & 0o777,
      symlinkFree,
    };
  } catch {
    return {
      path,
      kind: "missing",
      ownerUid: undefined,
      mode: undefined,
      symlinkFree,
    };
  }
}

export type NodeHostReadinessInspectorOptions = Readonly<{
  configurationPath: string;
  xdgRuntimeDirectory: string;
  workingDirectory: string;
}>;

export class NodeHostReadinessInspector implements HostReadinessInspector {
  private readonly configurationPath: string;
  private readonly xdgRuntimeDirectory: string;
  private readonly workingDirectory: string;

  constructor(options: NodeHostReadinessInspectorOptions) {
    this.configurationPath = options.configurationPath;
    this.xdgRuntimeDirectory = options.xdgRuntimeDirectory;
    this.workingDirectory = options.workingDirectory;
  }

  async inspect(): Promise<HostReadinessProbe> {
    const rootlessKitStateDirectory = `${this.xdgRuntimeDirectory}/containerd-rootless`;
    const [
      controllers,
      appArmorEnabled,
      configuration,
      configurationContents,
      runtimeDirectory,
      rootlessState,
      workingDirectory,
    ] = await Promise.all([
      readable("/sys/fs/cgroup/cgroup.controllers"),
      readable("/sys/module/apparmor/parameters/enabled"),
      pathAttestation(this.configurationPath),
      readFile(this.configurationPath).catch(() => undefined),
      pathAttestation(this.xdgRuntimeDirectory),
      pathAttestation(rootlessKitStateDirectory),
      pathAttestation(this.workingDirectory),
    ]);
    const configurationBytes = configurationContents
      ? Uint8Array.from(configurationContents)
      : undefined;
    return {
      platform: process.platform,
      uid: process.getuid?.(),
      cgroupControllers: controllers.trim().split(/\s+/).filter(Boolean),
      appArmorEnabled: appArmorEnabled.trim().toLowerCase() === "y",
      engineConfiguration: {
        ...configuration,
        sha256: configurationBytes
          ? createHash("sha256").update(configurationBytes).digest("hex")
          : undefined,
        exactBytes:
          configurationContents?.equals(
            Buffer.from(nerdctlConfigurationBytes, "utf8"),
          ) ?? false,
      },
      xdgRuntimeDirectory: runtimeDirectory,
      rootlessKitStateDirectory: rootlessState,
      workingDirectory,
    };
  }
}

export type ReadinessVerifierOptions = Readonly<{
  configurationPath: string;
  xdgRuntimeDirectory: string;
  workingDirectory: string;
  timeoutMs?: number;
  maximumOutputBytes?: number;
  now?: () => Date;
}>;

export class NerdctlReadinessVerifier implements ReadinessVerifier {
  private readonly configurationPath: string;
  private readonly xdgRuntimeDirectory: string;
  private readonly workingDirectory: string;
  private readonly timeoutMs: number;
  private readonly maximumOutputBytes: number;
  private readonly now: () => Date;

  constructor(
    private readonly processes: ProcessExecutor,
    private readonly host: HostReadinessInspector,
    private readonly invocation: NerdctlInvocation,
    options: ReadinessVerifierOptions,
  ) {
    this.configurationPath = options.configurationPath;
    this.xdgRuntimeDirectory = options.xdgRuntimeDirectory;
    this.workingDirectory = options.workingDirectory;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumOutputBytes = options.maximumOutputBytes ?? 256 * 1_024;
    this.now = options.now ?? (() => new Date());
  }

  private run(arguments_: readonly string[]): Promise<ProcessResult> {
    return this.processes.run(
      this.invocation.request(arguments_, {
        timeoutMs: this.timeoutMs,
        maximumOutputBytes: this.maximumOutputBytes,
      }),
    );
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
    if (clientVersion !== "2.3.1" && clientVersion !== "v2.3.1")
      failures.push("nerdctl is not the selected 2.3.1 release");
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
      host.engineConfiguration.path !== this.configurationPath ||
      host.engineConfiguration.kind !== "file" ||
      host.engineConfiguration.ownerUid !== 0 ||
      host.engineConfiguration.mode === undefined ||
      (host.engineConfiguration.mode & 0o022) !== 0 ||
      !host.engineConfiguration.symlinkFree ||
      host.engineConfiguration.sha256 !== nerdctlConfigurationSha256 ||
      !host.engineConfiguration.exactBytes
    ) {
      failures.push("nerdctl configuration authority is invalid");
    }
    if (
      host.uid === undefined ||
      this.xdgRuntimeDirectory !== `/run/user/${host.uid}` ||
      host.xdgRuntimeDirectory.path !== this.xdgRuntimeDirectory ||
      host.xdgRuntimeDirectory.kind !== "directory" ||
      host.xdgRuntimeDirectory.ownerUid !== host.uid ||
      host.xdgRuntimeDirectory.mode === undefined ||
      (host.xdgRuntimeDirectory.mode & 0o077) !== 0 ||
      !host.xdgRuntimeDirectory.symlinkFree
    ) {
      failures.push("XDG runtime authority is invalid");
    }
    if (
      host.rootlessKitStateDirectory.path !==
        `${this.xdgRuntimeDirectory}/containerd-rootless` ||
      host.rootlessKitStateDirectory.kind !== "directory" ||
      host.rootlessKitStateDirectory.ownerUid !== host.uid ||
      host.rootlessKitStateDirectory.mode === undefined ||
      (host.rootlessKitStateDirectory.mode & 0o077) !== 0 ||
      !host.rootlessKitStateDirectory.symlinkFree
    ) {
      failures.push("RootlessKit state authority is invalid");
    }
    if (
      host.workingDirectory.path !== this.workingDirectory ||
      host.workingDirectory.kind !== "directory" ||
      host.workingDirectory.ownerUid !== host.uid ||
      host.workingDirectory.mode === undefined ||
      (host.workingDirectory.mode & 0o077) !== 0 ||
      !host.workingDirectory.symlinkFree
    ) {
      failures.push("nerdctl working-directory authority is invalid");
    }
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
