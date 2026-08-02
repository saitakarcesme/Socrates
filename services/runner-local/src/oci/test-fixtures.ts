import { createSandboxOwnership } from "./identity";
import { NerdctlInvocation } from "./invocation";
import { createAdmittedImageForTesting } from "../image/testing";

import type { SandboxAttemptIdentity } from "./identity";
import type { ProcessRequest, ProcessResult } from "./process";
import type { AdmittedSandboxImage, SandboxResourceProfile } from "./profile";
import type { HostReadinessProbe, SandboxReadiness } from "./readiness";

export const fixtureIdentity: SandboxAttemptIdentity = {
  runnerId: "10000000-0000-4000-8000-000000000001",
  taskId: "20000000-0000-4000-8000-000000000002",
  attemptId: "30000000-0000-4000-8000-000000000003",
  fence: 7,
};

export const fixtureProfile: SandboxResourceProfile = {
  memoryBytes: 64 * 1_024 * 1_024,
  cpuCount: 0.5,
  maximumPids: 32,
  workspaceBytes: 1 * 1_024 * 1_024,
  temporaryBytes: 256 * 1_024,
  sharedMemoryBytes: 64 * 1_024,
};

export const fixtureImage: AdmittedSandboxImage = createAdmittedImageForTesting(
  "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  "amd64",
  `sha256:${"b".repeat(64)}`,
);

export const fixtureReadiness: SandboxReadiness = {
  checkedAt: "2026-07-31T00:00:00.000Z",
  nerdctlVersion: "2.3.1",
  serverVersion: "2.1.4",
  architecture: "amd64",
  cgroupVersion: "2",
  securityOptions: ["name=seccomp", "name=rootless"],
};

export const fixtureHostReadinessProbe: HostReadinessProbe = {
  platform: "linux",
  uid: 1_001,
  cgroupControllers: ["cpu", "memory", "pids"],
  appArmorEnabled: true,
  engineConfiguration: {
    path: "/etc/socrates/runner-local/nerdctl.toml",
    kind: "file",
    ownerUid: 0,
    mode: 0o444,
    symlinkFree: true,
    sha256: "455193711f3d711e4499f8875cdd65ed6f4c50cb3a7812bad3d181a280ad58cd",
    exactBytes: true,
  },
  xdgRuntimeDirectory: {
    path: "/run/user/1001",
    kind: "directory",
    ownerUid: 1_001,
    mode: 0o700,
    symlinkFree: true,
  },
  rootlessKitStateDirectory: {
    path: "/run/user/1001/containerd-rootless",
    kind: "directory",
    ownerUid: 1_001,
    mode: 0o700,
    symlinkFree: true,
  },
  workingDirectory: {
    path: "/home/socrates/.local/state/socrates/runner",
    kind: "directory",
    ownerUid: 1_001,
    mode: 0o700,
    symlinkFree: true,
  },
};

export function fixtureNerdctlInvocation(
  namespace = "socrates-test",
): NerdctlInvocation {
  return new NerdctlInvocation({
    executable: "/usr/local/bin/nerdctl",
    address: "unix:///run/containerd/containerd.sock",
    namespace,
    snapshotter: "overlayfs",
    dataRoot: "/home/socrates/.local/share/socrates/nerdctl",
    configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
    workingDirectory: "/home/socrates/.local/state/socrates/runner",
    environment: {
      home: "/home/socrates",
      path: "/usr/local/bin:/usr/bin:/bin",
      xdgConfigHome: "/home/socrates/.config/socrates",
      xdgDataHome: "/home/socrates/.local/share/socrates",
      xdgRuntimeDirectory: "/run/user/1001",
      dockerConfigDirectory: "/home/socrates/.config/socrates/docker",
    },
  });
}

export function fixtureNerdctlCommand(request: ProcessRequest): string {
  return request.arguments[12] ?? "";
}

export function fixtureNerdctlCommandArguments(
  request: ProcessRequest,
): readonly string[] {
  return request.arguments.slice(12);
}

export function successfulResult(
  stdout = "",
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  const stdoutBytes = Uint8Array.from(Buffer.from(stdout, "utf8"));
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes,
    stderrBytes: new Uint8Array(),
    durationMs: 1,
    ...overrides,
  };
}

export function fixtureNativeInspection(
  overrides: Record<string, unknown> = {},
): string {
  const spec = {
    process: {
      apparmorProfile: "socrates-sandbox",
      noNewPrivileges: true,
      user: { uid: 65_534, gid: 65_534 },
      env: ["SOCRATES_SANDBOX=1"],
      capabilities: {
        bounding: [],
        effective: [],
        inheritable: [],
        permitted: [],
        ambient: [],
      },
    },
    root: { readonly: true },
    mounts: [
      {
        destination: "/workspace",
        type: "tmpfs",
        options: [
          "rw",
          "noexec",
          "nosuid",
          "nodev",
          `size=${fixtureProfile.workspaceBytes}`,
        ],
      },
      {
        destination: "/tmp",
        type: "tmpfs",
        options: [
          "rw",
          "noexec",
          "nosuid",
          "nodev",
          `size=${fixtureProfile.temporaryBytes}`,
        ],
      },
      {
        destination: "/dev/shm",
        type: "tmpfs",
        options: [
          "rw",
          "noexec",
          "nosuid",
          "nodev",
          `size=${fixtureProfile.sharedMemoryBytes}`,
        ],
      },
    ],
    linux: {
      namespaces: ["mount", "pid", "ipc", "user", "cgroup", "network"].map(
        (type) => ({ type }),
      ),
      resources: {
        memory: {
          limit: fixtureProfile.memoryBytes,
          swap: fixtureProfile.memoryBytes,
        },
        cpu: { quota: 50_000, period: 100_000 },
        pids: { limit: fixtureProfile.maximumPids },
      },
    },
    ...overrides,
  };
  return JSON.stringify([{ Spec: spec }]);
}

export function fixtureCompatibleInspection(deploymentId: string): string {
  const ownership = createSandboxOwnership(deploymentId, fixtureIdentity);
  return JSON.stringify({
    Name: ownership.containerName,
    Image: `sha256:${"b".repeat(64)}`,
    Config: {
      Image: "docker.io/library/node:admission-candidate",
      Labels: ownership.labels,
    },
  });
}
