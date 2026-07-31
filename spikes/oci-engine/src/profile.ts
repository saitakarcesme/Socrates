import type { EngineName } from "./types";

export const sandboxProfile = {
  memoryBytes: 64 * 1_024 * 1_024,
  cpuCount: 0.5,
  maximumPids: 32,
  workspaceBytes: 1 * 1_024 * 1_024,
  temporaryBytes: 256 * 1_024,
  sharedMemoryBytes: 64 * 1_024,
  network: "none" as const,
  rootFilesystem: "read-only" as const,
};

export const sandboxAppArmorProfile = "socrates-sandbox";

type ContainerIdentity = {
  name: string;
  spikeId: string;
};

export function secureRunArguments(
  engine: EngineName,
  identity: ContainerIdentity,
  image: string,
  command: readonly string[],
): string[] {
  const noNewPrivileges =
    engine === "docker" ? "no-new-privileges:true" : "no-new-privileges";

  return [
    "run",
    "--name",
    identity.name,
    "--label",
    "socrates.managed=true",
    "--label",
    `socrates.spike.id=${identity.spikeId}`,
    "--network",
    "none",
    ...(engine === "podman" ? ["--pid", "private"] : []),
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--read-only",
    ...(engine === "podman" ? ["--read-only-tmpfs=false"] : []),
    "--tmpfs",
    `/workspace:rw,noexec,nosuid,nodev,size=${sandboxProfile.workspaceBytes}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${sandboxProfile.temporaryBytes}`,
    ...(engine === "podman"
      ? [
          "--tmpfs",
          `/dev/shm:rw,noexec,nosuid,nodev,size=${sandboxProfile.sharedMemoryBytes}`,
        ]
      : ["--shm-size", String(sandboxProfile.sharedMemoryBytes)]),
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    noNewPrivileges,
    ...(engine === "nerdctl"
      ? ["--security-opt", `apparmor=${sandboxAppArmorProfile}`]
      : []),
    "--memory",
    String(sandboxProfile.memoryBytes),
    "--memory-swap",
    String(sandboxProfile.memoryBytes),
    "--cpus",
    String(sandboxProfile.cpuCount),
    "--pids-limit",
    String(sandboxProfile.maximumPids),
    "--hostname",
    "socrates-sandbox",
    "--env",
    "SOCRATES_SANDBOX=1",
    image,
    ...command,
  ];
}

export function ownedContainerFilter(spikeId: string): string[] {
  return [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=socrates.managed=true",
    "--filter",
    `label=socrates.spike.id=${spikeId}`,
  ];
}
