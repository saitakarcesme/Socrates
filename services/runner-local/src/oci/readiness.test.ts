import { describe, expect, it } from "vitest";

import { NerdctlReadinessVerifier, SandboxReadinessError } from "./readiness";
import { successfulResult } from "./test-fixtures";

import type { ProcessExecutor, ProcessRequest } from "./process";
import type { HostReadinessInspector, HostReadinessProbe } from "./readiness";

class ReadinessProcesses implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly rootless = true) {}

  async run(request: ProcessRequest) {
    this.requests.push(request);
    if (request.arguments[0] === "version") {
      return successfulResult(
        JSON.stringify({
          Client: { Version: "v2.3.1" },
          Server: { Version: "2.1.4" },
        }),
      );
    }
    if (request.arguments[0] === "info") {
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

const passingHost: HostReadinessProbe = {
  platform: "linux",
  uid: 1_001,
  cgroupControllers: ["cpu", "memory", "pids"],
  appArmorEnabled: true,
};

describe("nerdctl readiness", () => {
  it("attests the selected rootless host contract", async () => {
    const processes = new ReadinessProcesses();
    const verifier = new NerdctlReadinessVerifier(
      processes,
      new FixedHost(passingHost),
      { now: () => new Date("2026-07-31T00:00:00.000Z") },
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
      processes.requests.every((request) => request.executable === "nerdctl"),
    ).toBe(true);
  });

  it("reports every missing fail-closed prerequisite", async () => {
    const verifier = new NerdctlReadinessVerifier(
      new ReadinessProcesses(false),
      new FixedHost({
        platform: "win32",
        uid: 0,
        cgroupControllers: [],
        appArmorEnabled: false,
      }),
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
});
