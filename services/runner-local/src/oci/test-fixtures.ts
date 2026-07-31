import { createSandboxOwnership } from "./identity";
import { createAdmittedImageForTesting } from "../image/testing";

import type { SandboxAttemptIdentity } from "./identity";
import type { ProcessResult } from "./process";
import type { AdmittedSandboxImage, SandboxResourceProfile } from "./profile";
import type { SandboxReadiness } from "./readiness";

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
);

export const fixtureReadiness: SandboxReadiness = {
  checkedAt: "2026-07-31T00:00:00.000Z",
  nerdctlVersion: "2.3.1",
  serverVersion: "2.1.4",
  architecture: "amd64",
  cgroupVersion: "2",
  securityOptions: ["name=seccomp", "name=rootless"],
};

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
      Image: fixtureImage.reference,
      Labels: ownership.labels,
    },
  });
}
