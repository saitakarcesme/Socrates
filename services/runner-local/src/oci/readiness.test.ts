import { describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nerdctlConfigurationBytes,
  NerdctlReadinessVerifier,
  NodeHostReadinessInspector,
  SandboxReadinessError,
} from "./readiness";
import {
  fixtureHostReadinessProbe,
  fixtureNerdctlInvocation,
  successfulResult,
} from "./test-fixtures";

import type { ProcessExecutor, ProcessRequest } from "./process";
import type { HostReadinessInspector, HostReadinessProbe } from "./readiness";

class ReadinessProcesses implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly rootless = true) {}

  async run(request: ProcessRequest) {
    this.requests.push(request);
    if (request.arguments.includes("version")) {
      return successfulResult(
        JSON.stringify({
          Client: { Version: "v2.3.1" },
          Server: { Version: "2.1.4" },
        }),
      );
    }
    if (request.arguments.includes("info")) {
      return successfulResult(
        JSON.stringify({
          Architecture: "x86_64",
          CgroupVersion: "2",
          SecurityOptions: [
            "name=seccomp",
            ...(this.rootless ? ["name=rootless"] : []),
          ],
        }),
      );
    }
    return successfulResult("Usage: nerdctl inspect --mode native");
  }
}

class FixedHost implements HostReadinessInspector {
  constructor(private readonly value: HostReadinessProbe) {}

  async inspect(): Promise<HostReadinessProbe> {
    return this.value;
  }
}

const passingHost: HostReadinessProbe = fixtureHostReadinessProbe;

describe("nerdctl readiness", () => {
  const linuxIt = process.platform === "linux" ? it : it.skip;

  linuxIt(
    "attests concrete host paths without following symlink authority",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "socrates-host-readiness-"));
      try {
        const actualConfigurationDirectory = join(root, "configuration");
        const linkedConfigurationDirectory = join(root, "linked-configuration");
        const configurationPath = join(
          linkedConfigurationDirectory,
          "nerdctl.toml",
        );
        const runtimeDirectory = join(root, "runtime");
        const workingDirectory = join(root, "working");
        await Promise.all([
          mkdir(actualConfigurationDirectory),
          mkdir(join(runtimeDirectory, "containerd-rootless"), {
            recursive: true,
          }),
          mkdir(workingDirectory),
        ]);
        await Promise.all([
          chmod(runtimeDirectory, 0o700),
          chmod(join(runtimeDirectory, "containerd-rootless"), 0o700),
          chmod(workingDirectory, 0o700),
          writeFile(
            join(actualConfigurationDirectory, "nerdctl.toml"),
            nerdctlConfigurationBytes,
            { mode: 0o444 },
          ),
        ]);
        await symlink(
          actualConfigurationDirectory,
          linkedConfigurationDirectory,
        );

        const probe = await new NodeHostReadinessInspector({
          configurationPath,
          xdgRuntimeDirectory: runtimeDirectory,
          workingDirectory,
        }).inspect();

        expect(probe.engineConfiguration).toMatchObject({
          path: configurationPath,
          kind: "file",
          symlinkFree: false,
          exactBytes: true,
        });
        expect(probe.xdgRuntimeDirectory).toMatchObject({
          path: runtimeDirectory,
          kind: "directory",
          mode: 0o700,
          symlinkFree: true,
        });
        expect(probe.rootlessKitStateDirectory).toMatchObject({
          path: join(runtimeDirectory, "containerd-rootless"),
          kind: "directory",
          mode: 0o700,
          symlinkFree: true,
        });
        expect(probe.workingDirectory).toMatchObject({
          path: workingDirectory,
          kind: "directory",
          mode: 0o700,
          symlinkFree: true,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("attests the selected rootless host contract", async () => {
    const processes = new ReadinessProcesses();
    const verifier = new NerdctlReadinessVerifier(
      processes,
      new FixedHost(passingHost),
      fixtureNerdctlInvocation(),
      {
        configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
        xdgRuntimeDirectory: "/run/user/1001",
        workingDirectory: "/home/socrates/.local/state/socrates/runner",
        now: () => new Date("2026-07-31T00:00:00.000Z"),
      },
    );

    await expect(verifier.verify()).resolves.toEqual({
      checkedAt: "2026-07-31T00:00:00.000Z",
      nerdctlVersion: "2.3.1",
      serverVersion: "2.1.4",
      architecture: "amd64",
      cgroupVersion: "2",
      securityOptions: ["name=seccomp", "name=rootless"],
    });
    expect(processes.requests).toHaveLength(3);
    expect(
      processes.requests.every(
        (request) => request.executable === "/usr/local/bin/nerdctl",
      ),
    ).toBe(true);
  });

  it("captures expected host authority paths at construction", async () => {
    const options = {
      configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
      xdgRuntimeDirectory: "/run/user/1001",
      workingDirectory: "/home/socrates/.local/state/socrates/runner",
    };
    const verifier = new NerdctlReadinessVerifier(
      new ReadinessProcesses(),
      new FixedHost(fixtureHostReadinessProbe),
      fixtureNerdctlInvocation(),
      options,
    );
    options.configurationPath = "/tmp/redirect.toml";
    options.xdgRuntimeDirectory = "/tmp/redirect-runtime";
    options.workingDirectory = "/tmp/redirect-working";

    await expect(verifier.verify()).resolves.toMatchObject({
      nerdctlVersion: "2.3.1",
    });
  });

  it("reports every missing fail-closed prerequisite", async () => {
    const verifier = new NerdctlReadinessVerifier(
      new ReadinessProcesses(false),
      new FixedHost({
        ...fixtureHostReadinessProbe,
        platform: "win32",
        uid: 0,
        cgroupControllers: [],
        appArmorEnabled: false,
      }),
      fixtureNerdctlInvocation(),
      {
        configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
        xdgRuntimeDirectory: "/run/user/1001",
        workingDirectory: "/home/socrates/.local/state/socrates/runner",
      },
    );

    const error = await verifier.verify().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SandboxReadinessError);
    expect((error as SandboxReadinessError).failures).toEqual(
      expect.arrayContaining([
        "host is not Linux",
        "runner is not unprivileged",
        "cpu cgroup controller is absent",
        "memory cgroup controller is absent",
        "pids cgroup controller is absent",
        "containerd is not rootless",
        "AppArmor is disabled",
      ]),
    );
  });

  it.each([
    [
      "configuration path",
      (host: HostReadinessProbe) => ({
        ...host,
        engineConfiguration: {
          ...host.engineConfiguration,
          path: "/tmp/redirect.toml",
        },
      }),
      "nerdctl configuration authority is invalid",
    ],
    [
      "configuration digest",
      (host: HostReadinessProbe) => ({
        ...host,
        engineConfiguration: {
          ...host.engineConfiguration,
          sha256: "0".repeat(64),
        },
      }),
      "nerdctl configuration authority is invalid",
    ],
    [
      "configuration ownership",
      (host: HostReadinessProbe) => ({
        ...host,
        engineConfiguration: { ...host.engineConfiguration, ownerUid: 1_001 },
      }),
      "nerdctl configuration authority is invalid",
    ],
    [
      "configuration writability",
      (host: HostReadinessProbe) => ({
        ...host,
        engineConfiguration: { ...host.engineConfiguration, mode: 0o664 },
      }),
      "nerdctl configuration authority is invalid",
    ],
    [
      "configuration symlink",
      (host: HostReadinessProbe) => ({
        ...host,
        engineConfiguration: {
          ...host.engineConfiguration,
          symlinkFree: false,
        },
      }),
      "nerdctl configuration authority is invalid",
    ],
    [
      "runtime UID",
      (host: HostReadinessProbe) => ({
        ...host,
        xdgRuntimeDirectory: {
          ...host.xdgRuntimeDirectory,
          ownerUid: 1_002,
        },
      }),
      "XDG runtime authority is invalid",
    ],
    [
      "runtime mode",
      (host: HostReadinessProbe) => ({
        ...host,
        xdgRuntimeDirectory: { ...host.xdgRuntimeDirectory, mode: 0o750 },
      }),
      "XDG runtime authority is invalid",
    ],
    [
      "RootlessKit path",
      (host: HostReadinessProbe) => ({
        ...host,
        rootlessKitStateDirectory: {
          ...host.rootlessKitStateDirectory,
          path: "/tmp/containerd-rootless",
        },
      }),
      "RootlessKit state authority is invalid",
    ],
    [
      "working directory",
      (host: HostReadinessProbe) => ({
        ...host,
        workingDirectory: { ...host.workingDirectory, mode: 0o750 },
      }),
      "nerdctl working-directory authority is invalid",
    ],
  ] as const)(
    "rejects drifted %s authority",
    async (_name, mutate, failure) => {
      const verifier = new NerdctlReadinessVerifier(
        new ReadinessProcesses(),
        new FixedHost(mutate(fixtureHostReadinessProbe)),
        fixtureNerdctlInvocation(),
        {
          configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
          xdgRuntimeDirectory: "/run/user/1001",
          workingDirectory: "/home/socrates/.local/state/socrates/runner",
        },
      );

      const error = await verifier.verify().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SandboxReadinessError);
      expect((error as SandboxReadinessError).failures).toContain(failure);
    },
  );
});
