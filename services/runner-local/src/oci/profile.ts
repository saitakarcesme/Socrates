import { assertAdmittedImage } from "../image/capability";
import type { SandboxOwnership } from "./identity";
import {
  resolveMaterializedSourceSnapshot,
  type MaterializedSourceSnapshot,
} from "../source/capability";
import type { SandboxAttemptIdentity } from "./identity";
import type { AdmittedSandboxImage } from "../image/capability";

export type { AdmittedSandboxImage } from "../image/capability";

export const sandboxAppArmorProfile = "socrates-sandbox";

export type SandboxResourceProfile = Readonly<{
  memoryBytes: number;
  cpuCount: number;
  maximumPids: number;
  workspaceBytes: number;
  temporaryBytes: number;
  sharedMemoryBytes: number;
}>;

export type SandboxCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

const absoluteExecutablePattern =
  /^\/(?:[^/\0.][^/\0]*|\.(?!\.?\/)[^/\0]+)(?:\/[^/\0]+)*$/;

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

export function validateSandboxProfile(profile: SandboxResourceProfile): void {
  for (const [name, value] of [
    ["memoryBytes", profile.memoryBytes],
    ["maximumPids", profile.maximumPids],
    ["workspaceBytes", profile.workspaceBytes],
    ["temporaryBytes", profile.temporaryBytes],
    ["sharedMemoryBytes", profile.sharedMemoryBytes],
  ] as const) {
    positiveInteger(name, value);
  }
  if (!Number.isFinite(profile.cpuCount) || profile.cpuCount <= 0) {
    throw new RangeError("cpuCount must be a positive finite number.");
  }
}

function commandArguments(command: SandboxCommand): readonly string[] {
  if (
    !absoluteExecutablePattern.test(command.executable) ||
    command.executable.includes("/../") ||
    command.executable.endsWith("/..")
  ) {
    throw new TypeError(
      "Sandbox executable must be a normalized absolute path.",
    );
  }
  if (
    command.arguments.length > 128 ||
    command.arguments.some(
      (argument) => argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    throw new TypeError("Sandbox command arguments are invalid.");
  }
  return [command.executable, ...command.arguments];
}

export function buildCreateArguments(input: {
  ownership: SandboxOwnership;
  image: AdmittedSandboxImage;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
  source?: MaterializedSourceSnapshot;
  deploymentId?: string;
  identity?: SandboxAttemptIdentity;
}): readonly string[] {
  assertAdmittedImage(input.image);
  validateSandboxProfile(input.profile);
  const labels = Object.entries(input.ownership.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--label", `${name}=${value}`]);
  const sourceArguments = input.source
    ? sourceMountArguments(input.source, input.deploymentId, input.identity)
    : [];

  return [
    "create",
    "--name",
    input.ownership.containerName,
    ...labels,
    "--network",
    "none",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--read-only",
    ...sourceArguments,
    "--tmpfs",
    `/workspace:rw,noexec,nosuid,nodev,size=${input.profile.workspaceBytes}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${input.profile.temporaryBytes}`,
    "--tmpfs",
    `/dev/shm:rw,noexec,nosuid,nodev,size=${input.profile.sharedMemoryBytes}`,
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `apparmor=${sandboxAppArmorProfile}`,
    "--memory",
    String(input.profile.memoryBytes),
    "--memory-swap",
    String(input.profile.memoryBytes),
    "--cpus",
    String(input.profile.cpuCount),
    "--pids-limit",
    String(input.profile.maximumPids),
    "--hostname",
    "socrates-sandbox",
    "--env",
    "SOCRATES_SANDBOX=1",
    input.image.reference,
    ...commandArguments(input.command),
  ];
}

function sourceMountArguments(
  source: MaterializedSourceSnapshot,
  deploymentId: string | undefined,
  identity: SandboxAttemptIdentity | undefined,
): readonly string[] {
  if (!deploymentId || !identity) {
    throw new TypeError(
      "A source capability requires deployment and attempt identity.",
    );
  }
  const path = resolveMaterializedSourceSnapshot(
    source,
    deploymentId,
    identity,
  );
  if (path.includes(",") || path.includes("\0")) {
    throw new TypeError("Materialized source path is not mount-safe.");
  }
  return [
    "--mount",
    `type=bind,src=${path},dst=/socrates/source,rro,bind-propagation=rprivate`,
  ];
}
