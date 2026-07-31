import { randomUUID } from "node:crypto";

import { commandExists, runCommand } from "./process";
import {
  ownedContainerFilter,
  sandboxProfile,
  secureRunArguments,
} from "./profile";
import { summarizeLatency } from "./statistics";

import type {
  CommandResult,
  EngineFacts,
  EngineName,
  GateResult,
  SpikeEvidence,
} from "./types";

type DockerInfo = {
  Architecture?: string;
  CgroupDriver?: string;
  CgroupVersion?: string;
  Driver?: string;
  KernelVersion?: string;
  OperatingSystem?: string;
  OSType?: string;
  SecurityOptions?: string[];
  ServerVersion?: string;
};

type DockerVersion = {
  Client?: { Version?: string };
  Server?: { Version?: string };
};

type DockerInspection = {
  State?: {
    ExitCode?: number;
    OOMKilled?: boolean;
    Running?: boolean;
  };
  HostConfig?: {
    AutoRemove?: boolean;
    CapDrop?: string[];
    CgroupnsMode?: string;
    CpuQuota?: number;
    Devices?: unknown[];
    IpcMode?: string;
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    NetworkMode?: string;
    PidMode?: string;
    PidsLimit?: number;
    Privileged?: boolean;
    ReadonlyRootfs?: boolean;
    SecurityOpt?: string[];
  };
};

const probeTimeoutMs = 20_000;

function parseJson<T>(result: CommandResult, description: string): T {
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${result.exitCode}.`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`${description} returned invalid JSON.`, { cause: error });
  }
}

function isDesktopOrVm(info: DockerInfo): boolean {
  const description =
    `${info.OperatingSystem ?? ""} ${info.KernelVersion ?? ""}`.toLowerCase();
  return ["docker desktop", "linuxkit", "microsoft", "wsl"].some((value) =>
    description.includes(value),
  );
}

function securityOption(options: readonly string[], expected: string): boolean {
  return options.some((option) => option.toLowerCase().includes(expected));
}

async function readDockerFacts(): Promise<EngineFacts> {
  if (!(await commandExists("docker"))) {
    return {
      engine: "docker",
      available: false,
      securityOptions: [],
      nativeLinux: false,
      rootless: false,
      desktopOrVm: false,
    };
  }

  const [infoResult, versionResult] = await Promise.all([
    runCommand("docker", ["info", "--format", "{{json .}}"]),
    runCommand("docker", ["version", "--format", "{{json .}}"]),
  ]);
  const info = parseJson<DockerInfo>(infoResult, "docker info");
  const version = parseJson<DockerVersion>(versionResult, "docker version");
  const securityOptions = info.SecurityOptions ?? [];
  const desktopOrVm = isDesktopOrVm(info);
  return {
    engine: "docker",
    available: true,
    clientVersion: version.Client?.Version,
    serverVersion: version.Server?.Version ?? info.ServerVersion,
    operatingSystem: info.OperatingSystem,
    architecture: info.Architecture,
    kernelVersion: info.KernelVersion,
    cgroupVersion: info.CgroupVersion,
    cgroupDriver: info.CgroupDriver,
    storageDriver: info.Driver,
    securityOptions,
    nativeLinux: info.OSType === "linux" && !desktopOrVm,
    rootless: securityOption(securityOptions, "rootless"),
    desktopOrVm,
  };
}

async function inspectContainer(name: string): Promise<DockerInspection> {
  const result = await runCommand("docker", [
    "inspect",
    "--format",
    "{{json .}}",
    name,
  ]);
  return parseJson<DockerInspection>(result, `inspect ${name}`);
}

async function ownedContainerIds(spikeId: string): Promise<string[]> {
  const result = await runCommand("docker", ownedContainerFilter(spikeId));
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function cleanupOwnedContainers(spikeId: string): Promise<GateResult> {
  const ids = await ownedContainerIds(spikeId);
  if (ids.length > 0) {
    await runCommand("docker", ["rm", "--force", ...ids], 15_000);
  }
  const remaining = await ownedContainerIds(spikeId);
  return {
    name: "owned container cleanup",
    passed: remaining.length === 0,
    detail:
      remaining.length === 0
        ? `removed ${ids.length} owned container(s)`
        : `${remaining.length} owned container(s) remain`,
  };
}

async function runProbe(
  spikeId: string,
  image: string,
  nameSuffix: string,
  command: readonly string[],
): Promise<{
  result: CommandResult;
  inspection: DockerInspection;
  cleanup: GateResult;
}> {
  const name = `socrates-spike-${nameSuffix}-${randomUUID().slice(0, 8)}`;
  try {
    const result = await runCommand(
      "docker",
      secureRunArguments("docker", { name, spikeId }, image, command),
      probeTimeoutMs,
    );
    return {
      result,
      inspection: await inspectContainer(name),
      cleanup: await cleanupOwnedContainers(spikeId),
    };
  } catch (error) {
    await cleanupOwnedContainers(spikeId);
    throw error;
  }
}

function fixedProfileIsApplied(inspection: DockerInspection): GateResult {
  const host = inspection.HostConfig;
  const passed =
    host?.NetworkMode === "none" &&
    host.ReadonlyRootfs === true &&
    host.Privileged === false &&
    host.Memory === sandboxProfile.memoryBytes &&
    host.MemorySwap === sandboxProfile.memoryBytes &&
    host.PidsLimit === sandboxProfile.maximumPids &&
    ((host.NanoCpus ?? 0) > 0 || (host.CpuQuota ?? 0) > 0) &&
    host.CapDrop?.includes("ALL") === true &&
    host.CgroupnsMode === "private" &&
    host.IpcMode === "private" &&
    (host.PidMode ?? "") === "" &&
    (host.Devices?.length ?? 0) === 0 &&
    host.SecurityOpt?.some((option) =>
      option.toLowerCase().includes("no-new-privileges"),
    ) === true;
  return {
    name: "fixed sandbox profile",
    passed,
    detail: passed
      ? "inspect confirms network, rootfs, privilege, memory, PID, capability, and escalation controls"
      : "one or more requested sandbox controls were not reported by inspect",
  };
}

async function runAdversarialProbes(
  spikeId: string,
  image: string,
): Promise<{
  gates: GateResult[];
  cleanup: GateResult[];
}> {
  const gates: GateResult[] = [];
  const cleanup: GateResult[] = [];

  const security = await runProbe(spikeId, image, "security", [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      'test "$(id -u)" = "65534"',
      "grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status",
      "test ! -e /var/run/docker.sock",
      "test ! -e /run/podman/podman.sock",
      "test ! -e /run/containerd/containerd.sock",
      "test ! -e /host",
      'controllers="$(cat /sys/fs/cgroup/cgroup.controllers)"',
      'for required in cpu memory pids; do echo "$controllers" | grep -qw "$required"; done',
      "printf '%s\\n' \"$controllers\"",
      "mkdir /tmp/mount-target",
      "if mount -t tmpfs none /tmp/mount-target 2>/dev/null; then exit 41; fi",
      "if unshare -m true 2>/dev/null; then exit 42; fi",
      "printf security-denied",
    ].join("; "),
  ]);
  gates.push({
    name: "delegated cgroup controllers",
    passed:
      security.result.exitCode === 0 &&
      ["cpu", "memory", "pids"].every((controller) =>
        security.result.stdout.includes(controller),
      ),
    detail:
      security.result.exitCode === 0
        ? "cpu, memory, and pids controllers are visible"
        : `probe exited ${security.result.exitCode}`,
  });
  gates.push({
    name: "host mount and privilege denial",
    passed:
      security.result.exitCode === 0 &&
      security.result.stdout.includes("security-denied"),
    detail:
      security.result.exitCode === 0
        ? "non-root identity, empty effective capabilities, absent sockets, mount denial, and namespace denial observed"
        : `probe exited ${security.result.exitCode}`,
  });
  gates.push(fixedProfileIsApplied(security.inspection));
  cleanup.push(security.cleanup);

  const network = await runProbe(spikeId, image, "network", [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      "if wget -q -T 2 -O /tmp/direct http://1.1.1.1; then exit 41; fi",
      "if nslookup example.com >/tmp/dns 2>&1; then exit 42; fi",
      "printf network-denied",
    ].join("; "),
  ]);
  gates.push({
    name: "network denial",
    passed:
      network.result.exitCode === 0 &&
      network.result.stdout.includes("network-denied"),
    detail:
      network.result.exitCode === 0
        ? "direct-IP HTTP and DNS probes both failed"
        : `probe exited ${network.result.exitCode}`,
  });
  cleanup.push(network.cleanup);

  const secrets = await runProbe(spikeId, image, "secrets", [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      "if env | grep -q SOCRATES_SPIKE_SENTINEL_SECRET; then exit 41; fi",
      "test ! -e /root/.aws/credentials",
      "test ! -e /root/.config/gcloud/application_default_credentials.json",
      "printf secrets-absent",
    ].join("; "),
  ]);
  gates.push({
    name: "host secret absence",
    passed:
      secrets.result.exitCode === 0 &&
      secrets.result.stdout.includes("secrets-absent"),
    detail:
      secrets.result.exitCode === 0
        ? "host sentinel and standard credential files were absent"
        : `probe exited ${secrets.result.exitCode}`,
  });
  cleanup.push(secrets.cleanup);

  const disk = await runProbe(spikeId, image, "disk", [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      "if dd if=/dev/zero of=/workspace/fill bs=1024 count=2048 2>/tmp/dd-error; then exit 41; fi",
      'bytes="$(wc -c < /workspace/fill)"',
      `test "$bytes" -le "${sandboxProfile.workspaceBytes}"`,
      "printf workspace-enospc",
    ].join("; "),
  ]);
  gates.push({
    name: "workspace writable-byte limit",
    passed:
      disk.result.exitCode === 0 &&
      disk.result.stdout.includes("workspace-enospc"),
    detail:
      disk.result.exitCode === 0
        ? "workspace tmpfs returned ENOSPC within its declared bound"
        : `probe exited ${disk.result.exitCode}`,
  });
  cleanup.push(disk.cleanup);

  const pids = await runProbe(spikeId, image, "pids", [
    "node",
    "-e",
    [
      "const {spawn}=require('node:child_process');",
      "let spawned=0, rejected=0, settled=0;",
      "const children=[];",
      "for(let i=0;i<64;i++){",
      " const child=spawn('/bin/sleep',['2']); children.push(child);",
      " child.once('spawn',()=>{spawned++;});",
      " child.once('error',()=>{rejected++; settled++;});",
      " child.once('exit',()=>{settled++;});",
      "}",
      "setTimeout(()=>{",
      " for(const child of children){child.kill('SIGKILL');}",
      " console.log(JSON.stringify({spawned,rejected,settled}));",
      " process.exit(rejected>0 && spawned<32 ? 0 : 41);",
      "},750);",
    ].join(""),
  ]);
  gates.push({
    name: "PID limit",
    passed: pids.result.exitCode === 0,
    detail:
      pids.result.exitCode === 0
        ? "bounded child fan-out encountered cgroup rejection below the requested cap"
        : `probe exited ${pids.result.exitCode}`,
  });
  cleanup.push(pids.cleanup);

  const memory = await runProbe(spikeId, image, "memory", [
    "node",
    "-e",
    "Buffer.alloc(128*1024*1024).fill(1); setTimeout(()=>{},10000);",
  ]);
  gates.push({
    name: "memory limit",
    passed:
      memory.inspection.State?.OOMKilled === true ||
      memory.inspection.State?.ExitCode === 137,
    detail:
      memory.inspection.State?.OOMKilled === true
        ? "engine reported OOMKilled"
        : `exit=${memory.inspection.State?.ExitCode ?? "unknown"} oom=${String(memory.inspection.State?.OOMKilled)}`,
  });
  cleanup.push(memory.cleanup);

  return { gates, cleanup };
}

async function runCancellationProbe(
  spikeId: string,
  image: string,
): Promise<{
  gates: GateResult[];
  cleanup: GateResult[];
}> {
  const name = `socrates-spike-cancel-${randomUUID().slice(0, 8)}`;
  const cleanup: GateResult[] = [];
  try {
    const secureArguments = secureRunArguments(
      "docker",
      { name, spikeId },
      image,
      ["/bin/sh", "-c", 'trap "" TERM; sleep 300 & wait'],
    );
    const started = await runCommand("docker", [
      secureArguments[0]!,
      "--detach",
      ...secureArguments.slice(1),
    ]);
    if (started.exitCode !== 0) {
      return {
        gates: [
          {
            name: "hard cancellation",
            passed: false,
            detail: `detached start exited ${started.exitCode}`,
          },
        ],
        cleanup: [await cleanupOwnedContainers(spikeId)],
      };
    }

    const stopped = await runCommand(
      "docker",
      ["stop", "--time", "1", name],
      10_000,
    );
    const inspection = await inspectContainer(name);
    const cancellationGate = {
      name: "hard cancellation",
      passed:
        stopped.exitCode === 0 &&
        stopped.durationMs < 5_000 &&
        inspection.State?.Running === false,
      detail:
        stopped.exitCode === 0
          ? `TERM-resistant workload stopped in ${stopped.durationMs} ms`
          : `stop exited ${stopped.exitCode}`,
      durationMs: stopped.durationMs,
    };
    cleanup.push(await cleanupOwnedContainers(spikeId));
    return { gates: [cancellationGate], cleanup };
  } catch (error) {
    cleanup.push(await cleanupOwnedContainers(spikeId));
    throw error;
  }
}

async function measureRunAndRemove(
  spikeId: string,
  image: string,
  warmups: number,
  samples: number,
): Promise<ReturnType<typeof summarizeLatency>> {
  for (let index = 0; index < warmups; index += 1) {
    await runProbe(spikeId, image, "warmup", ["/bin/true"]);
  }
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const probe = await runProbe(spikeId, image, "latency", ["/bin/true"]);
    durations.push(probe.result.durationMs);
  }
  return summarizeLatency(durations);
}

export async function runDockerSpike(input: {
  image: string;
  allowDevelopmentHost: boolean;
  latencySamples: number;
}): Promise<SpikeEvidence> {
  const spikeId = randomUUID();
  const recordedAt = new Date().toISOString();
  const facts = await readDockerFacts();
  const pinnedImage = /@sha256:[a-f0-9]{64}$/.test(input.image);
  const preflight: GateResult[] = [
    {
      name: "engine available",
      passed: facts.available,
      detail: facts.available
        ? "docker client and daemon responded"
        : "missing",
    },
    {
      name: "image pinned by digest",
      passed: pinnedImage,
      detail: pinnedImage
        ? "immutable digest supplied"
        : "tag or invalid digest",
    },
    {
      name: "native Linux host",
      passed: facts.nativeLinux,
      detail: facts.nativeLinux
        ? "native Linux engine observed"
        : "Desktop, WSL, VM, or non-Linux host observed",
    },
    {
      name: "rootless engine",
      passed: facts.rootless,
      detail: facts.rootless
        ? "rootless security option reported"
        : "rootless security option not reported",
    },
    {
      name: "cgroup v2",
      passed: facts.cgroupVersion === "2",
      detail: `reported cgroup version ${facts.cgroupVersion ?? "unknown"}`,
    },
    {
      name: "seccomp",
      passed: securityOption(facts.securityOptions, "seccomp"),
      detail: securityOption(facts.securityOptions, "seccomp")
        ? "seccomp security option reported"
        : "seccomp not reported",
    },
    {
      name: "host LSM",
      passed:
        securityOption(facts.securityOptions, "apparmor") ||
        securityOption(facts.securityOptions, "selinux"),
      detail: "requires AppArmor or SELinux on the native reference host",
    },
  ];

  const canRunDevelopmentEvidence =
    facts.available &&
    pinnedImage &&
    (facts.nativeLinux || input.allowDevelopmentHost);
  const limitations: string[] = [];
  if (!facts.nativeLinux) {
    limitations.push(
      "Development-host evidence cannot select the production engine.",
    );
  }
  if (!facts.rootless) {
    limitations.push(
      "The observed engine is not rootless and fails the production preflight.",
    );
  }

  let adversarial: GateResult[] = [];
  let cancellation: GateResult[] = [];
  const cleanup: GateResult[] = [];
  let latency: SpikeEvidence["latency"];
  process.env["SOCRATES_SPIKE_SENTINEL_SECRET"] = randomUUID();
  try {
    if (canRunDevelopmentEvidence) {
      const adversarialResult = await runAdversarialProbes(
        spikeId,
        input.image,
      );
      adversarial = adversarialResult.gates;
      cleanup.push(...adversarialResult.cleanup);

      const cancellationResult = await runCancellationProbe(
        spikeId,
        input.image,
      );
      cancellation = cancellationResult.gates;
      cleanup.push(...cancellationResult.cleanup);

      latency = {
        runAndRemove: await measureRunAndRemove(
          spikeId,
          input.image,
          5,
          input.latencySamples,
        ),
      };
    } else {
      limitations.push(
        "Adversarial probes were not run because availability, digest, or host authorization failed.",
      );
    }
  } finally {
    delete process.env["SOCRATES_SPIKE_SENTINEL_SECRET"];
    if (facts.available) {
      cleanup.push(await cleanupOwnedContainers(spikeId));
    }
  }

  const eligibleForNativeSelection =
    preflight.every((gate) => gate.passed) &&
    adversarial.length > 0 &&
    adversarial.every((gate) => gate.passed) &&
    cancellation.every((gate) => gate.passed) &&
    cleanup.every((gate) => gate.passed);

  return {
    schemaVersion: "1",
    spikeId,
    recordedAt,
    image: input.image,
    profile: sandboxProfile,
    facts,
    preflight,
    adversarial,
    cancellation,
    cleanup,
    latency,
    eligibleForNativeSelection,
    limitations,
  };
}

export async function unavailableEngineEvidence(
  engine: Exclude<EngineName, "docker">,
  image: string,
): Promise<SpikeEvidence> {
  const available = await commandExists(engine);
  return {
    schemaVersion: "1",
    spikeId: randomUUID(),
    recordedAt: new Date().toISOString(),
    image,
    profile: sandboxProfile,
    facts: {
      engine,
      available,
      securityOptions: [],
      nativeLinux: false,
      rootless: false,
      desktopOrVm: false,
    },
    preflight: [
      {
        name: "engine available",
        passed: false,
        detail: available
          ? "candidate adapter is not implemented in this host spike"
          : `${engine} is not installed`,
      },
    ],
    adversarial: [],
    cancellation: [],
    cleanup: [],
    eligibleForNativeSelection: false,
    limitations: [
      "No evidence was executed for this candidate on the current host.",
    ],
  };
}
