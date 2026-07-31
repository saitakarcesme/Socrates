import { describe, expect, it } from "vitest";

import { NerdctlSandboxBackend } from "./backend";
import { createSandboxOwnership } from "./identity";
import {
  fixtureCompatibleInspection,
  fixtureIdentity,
  fixtureImage,
  fixtureNativeInspection,
  fixtureProfile,
  fixtureReadiness,
  successfulResult,
} from "./test-fixtures";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import { issueInspectedSandboxImage } from "../image/capability";

import type { ProcessExecutor, ProcessRequest, ProcessResult } from "./process";
import type { ReadinessVerifier } from "./readiness";
import type { MaterializedSourceSnapshot } from "../source/capability";

const deploymentId = "test-deployment";

class PassingReadiness implements ReadinessVerifier {
  calls = 0;

  async verify() {
    this.calls += 1;
    return fixtureReadiness;
  }
}

class LifecycleProcesses implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];
  private compatibleInspection = "";
  private starts = 0;

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const command = request.arguments[0];
    if (command === "create") {
      const nameIndex = request.arguments.indexOf("--name");
      const labels: Record<string, string> = {};
      for (let index = 0; index < request.arguments.length; index += 1) {
        if (request.arguments[index] !== "--label") continue;
        const label = request.arguments[index + 1] ?? "";
        const separator = label.indexOf("=");
        labels[label.slice(0, separator)] = label.slice(separator + 1);
      }
      this.compatibleInspection = JSON.stringify({
        Name: request.arguments[nameIndex + 1],
        Image: fixtureImage.digest,
        Config: { Image: fixtureImage.reference, Labels: labels },
      });
      return successfulResult();
    }
    if (command === "inspect" && request.arguments.includes("--mode")) {
      return successfulResult(fixtureNativeInspection());
    }
    if (command === "inspect") {
      return successfulResult(this.compatibleInspection);
    }
    if (command === "start") {
      this.starts += 1;
      if (this.starts === 1) {
        return successfulResult(
          JSON.stringify({
            label: "socrates-sandbox (enforce)",
            denied: true,
            uidMap: "0 100000 65536",
            capabilities: {
              CapInh: "0000000000000000",
              CapPrm: "0000000000000000",
              CapEff: "0000000000000000",
              CapBnd: "0000000000000000",
              CapAmb: "0000000000000000",
            },
          }),
        );
      }
      return request.arguments.includes("--attach")
        ? successfulResult("ok", { durationMs: 17 })
        : successfulResult();
    }
    if (command === "attach") return successfulResult("ok", { durationMs: 17 });
    if (command === "rm") return successfulResult();
    throw new Error(`Unexpected command ${String(command)}.`);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function backend(
  processes: ProcessExecutor,
  readiness = new PassingReadiness(),
) {
  return {
    readiness,
    value: new NerdctlSandboxBackend(processes, readiness, {
      deploymentId,
      runnerId: fixtureIdentity.runnerId,
      now: () => 1_000,
    }),
  };
}

describe("nerdctl sandbox backend", () => {
  it("rejects forged source capabilities before host attestation", async () => {
    const processes = new LifecycleProcesses();
    const { value, readiness } = backend(processes);

    await expect(
      value.execute({
        identity: fixtureIdentity,
        image: fixtureImage,
        profile: fixtureProfile,
        command: { executable: "/bin/true", arguments: [] },
        source: {
          snapshot: {
            attemptKey: "forged",
            digest: `sha256:${"0".repeat(64)}`,
            archiveBytes: 1,
            expandedBytes: 1,
            entryCount: 1,
          } as unknown as MaterializedSourceSnapshot,
          expectedDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toThrow("does not belong");
    expect(readiness.calls).toBe(0);
    expect(processes.requests).toEqual([]);
  });

  it("rejects a genuine source capability with the wrong task digest", async () => {
    const processes = new LifecycleProcesses();
    const { value, readiness } = backend(processes);
    const snapshot = issueMaterializedSourceSnapshot({
      path: "/runner/sources/source-owned/tree",
      deploymentId,
      identity: fixtureIdentity,
      digest: `sha256:${"a".repeat(64)}`,
      archiveBytes: 1_024,
      expandedBytes: 12,
      entryCount: 2,
    });

    await expect(
      value.execute({
        identity: fixtureIdentity,
        image: fixtureImage,
        profile: fixtureProfile,
        command: { executable: "/bin/true", arguments: [] },
        source: {
          snapshot,
          expectedDigest: `sha256:${"b".repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject<Partial<Error>>({
      message:
        "Materialized source digest does not match the execution snapshot.",
    });
    expect(readiness.calls).toBe(0);
    expect(processes.requests).toEqual([]);
  });

  it("attests, creates, verifies, starts, and removes in order", async () => {
    const processes = new LifecycleProcesses();
    const { value, readiness } = backend(processes);

    await expect(
      value.execute({
        identity: fixtureIdentity,
        image: fixtureImage,
        profile: fixtureProfile,
        command: {
          executable: "/usr/local/bin/node",
          arguments: ["--version"],
        },
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      stdoutBytes: Uint8Array.from(Buffer.from("ok")),
      stderrBytes: new Uint8Array(),
      durationMs: 17,
    });

    expect(readiness.calls).toBe(1);
    expect(processes.requests.map((request) => request.arguments[0])).toEqual([
      "create",
      "inspect",
      "inspect",
      "start",
      "rm",
      "create",
      "inspect",
      "inspect",
      "start",
      "rm",
    ]);
    expect(processes.requests[7]?.arguments).toEqual([
      "inspect",
      "--mode",
      "native",
      createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
    ]);
  });

  it("starts an interactive sandbox before attaching bounded stdin", async () => {
    const processes = new LifecycleProcesses();
    const { value } = backend(processes);
    const stdin = Uint8Array.from([0, 1, 2, 255]);

    await value.executeRuntime({
      identity: fixtureIdentity,
      image: fixtureImage,
      profile: fixtureProfile,
      stdin,
      maximumInputBytes: stdin.byteLength,
    });

    const creates = processes.requests.filter(
      (request) => request.arguments[0] === "create",
    );
    const starts = processes.requests.filter(
      (request) => request.arguments[0] === "start",
    );
    const attaches = processes.requests.filter(
      (request) => request.arguments[0] === "attach",
    );
    expect(creates[0]?.arguments).not.toContain("--interactive");
    expect(creates[1]?.arguments).toContain("--interactive");
    expect(starts[0]?.stdin).toBeUndefined();
    expect(starts[1]?.arguments).toEqual([
      "start",
      createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
    ]);
    expect(starts[1]?.stdin).toBeUndefined();
    expect(attaches).toHaveLength(1);
    expect(attaches[0]).toMatchObject({
      stdin,
      maximumInputBytes: stdin.byteLength,
    });
  });

  it("allows inspected images only on the admission-probe path", async () => {
    const processes = new LifecycleProcesses();
    const { value } = backend(processes);
    const inspected = issueInspectedSandboxImage({
      reference: fixtureImage.reference,
      localName: fixtureImage.localName,
      digest: fixtureImage.digest,
      configurationDigest: fixtureImage.configurationDigest,
      architecture: fixtureImage.architecture,
      profileProbe: fixtureImage.profileProbe,
    });

    await expect(
      value.executeInspectedImage({
        identity: fixtureIdentity,
        image: inspected,
        profile: fixtureProfile,
        command: {
          executable: "/usr/local/bin/node",
          arguments: ["/opt/socrates/task-runtime.mjs", "--handshake"],
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    await expect(
      value.execute({
        identity: fixtureIdentity,
        image: inspected as unknown as typeof fixtureImage,
        profile: fixtureProfile,
        command: fixtureImage.runtime,
      }),
    ).rejects.toThrow(/not admitted/u);
  });

  it("rejects an inspected-image lookalike before host attestation", async () => {
    const processes = new LifecycleProcesses();
    const { value, readiness } = backend(processes);
    const forged = {
      reference: fixtureImage.reference,
      localName: fixtureImage.localName,
      digest: fixtureImage.digest,
      configurationDigest: fixtureImage.configurationDigest,
      architecture: fixtureImage.architecture,
      profileProbe: fixtureImage.profileProbe,
    };

    await expect(
      value.executeInspectedImage({
        identity: fixtureIdentity,
        image: forged as never,
        profile: fixtureProfile,
        command: fixtureImage.runtime,
      }),
    ).rejects.toThrow(/verified local inspection/u);
    expect(readiness.calls).toBe(0);
    expect(processes.requests).toEqual([]);
  });

  it("cleans up without starting when native inspection fails", async () => {
    const processes = new LifecycleProcesses();
    const originalRun = processes.run.bind(processes);
    processes.run = async (request) => {
      if (
        request.arguments[0] === "inspect" &&
        request.arguments.includes("--mode")
      ) {
        processes.requests.push(request);
        return successfulResult("[]");
      }
      return originalRun(request);
    };
    const { value } = backend(processes);

    await expect(
      value.execute({
        identity: fixtureIdentity,
        image: fixtureImage,
        profile: fixtureProfile,
        command: { executable: "/bin/true", arguments: [] },
      }),
    ).rejects.toThrow("omitted Spec");
    expect(processes.requests.map((request) => request.arguments[0])).toEqual([
      "create",
      "inspect",
      "inspect",
      "rm",
    ]);
  });

  it("uses full attempt identity for cancellation ownership", async () => {
    const processes = new LifecycleProcesses();
    const { value } = backend(processes);
    await expect(
      value.cancel({ ...fixtureIdentity, fence: fixtureIdentity.fence + 1 }, 0),
    ).resolves.toBe(false);
    expect(processes.requests).toHaveLength(0);
  });

  it("escalates cancellation only for the exact active fence", async () => {
    const started = deferred<void>();
    const execution = deferred<ProcessResult>();
    const requests: ProcessRequest[] = [];
    let compatibleInspection = "";
    let starts = 0;
    const processes: ProcessExecutor = {
      async run(request) {
        requests.push(request);
        const command = request.arguments[0];
        if (command === "create") {
          const nameIndex = request.arguments.indexOf("--name");
          const labels: Record<string, string> = {};
          for (let index = 0; index < request.arguments.length; index += 1) {
            if (request.arguments[index] !== "--label") continue;
            const label = request.arguments[index + 1] ?? "";
            const separator = label.indexOf("=");
            labels[label.slice(0, separator)] = label.slice(separator + 1);
          }
          compatibleInspection = JSON.stringify({
            Name: request.arguments[nameIndex + 1],
            Image: fixtureImage.digest,
            Config: { Image: fixtureImage.reference, Labels: labels },
          });
          return successfulResult();
        }
        if (command === "inspect" && request.arguments.includes("--mode")) {
          return successfulResult(fixtureNativeInspection());
        }
        if (command === "inspect")
          return successfulResult(compatibleInspection);
        if (command === "start") {
          starts += 1;
          if (starts === 1) {
            return successfulResult(
              JSON.stringify({
                label: "socrates-sandbox (enforce)",
                denied: true,
                uidMap: "0 100000 65536",
                capabilities: {
                  CapInh: "0000000000000000",
                  CapPrm: "0000000000000000",
                  CapEff: "0000000000000000",
                  CapBnd: "0000000000000000",
                  CapAmb: "0000000000000000",
                },
              }),
            );
          }
          started.resolve();
          return execution.promise;
        }
        return successfulResult();
      },
    };
    const { value } = backend(processes);
    const running = value.execute({
      identity: fixtureIdentity,
      image: fixtureImage,
      profile: fixtureProfile,
      command: { executable: "/bin/true", arguments: [] },
    });
    await started.promise;

    await expect(value.cancel(fixtureIdentity, 1_500)).resolves.toBe(true);
    expect(
      requests
        .filter((request) =>
          ["stop", "kill"].includes(String(request.arguments[0])),
        )
        .map((request) => request.arguments),
    ).toEqual([
      [
        "stop",
        "--time",
        "1",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
      [
        "kill",
        "--signal",
        "KILL",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
    ]);

    execution.resolve(
      successfulResult("", {
        exitCode: 137,
        signal: "SIGKILL",
      }),
    );
    await expect(running).resolves.toMatchObject({ exitCode: 137 });
  });

  it("recovers only deployment-and-runner scoped containers", async () => {
    const ownership = createSandboxOwnership(deploymentId, fixtureIdentity);
    const requests: ProcessRequest[] = [];
    const processes: ProcessExecutor = {
      async run(request) {
        requests.push(request);
        if (request.arguments[0] === "ps")
          return successfulResult(`${ownership.containerName}\n`);
        if (request.arguments[0] === "inspect")
          return successfulResult(fixtureCompatibleInspection(deploymentId));
        return successfulResult();
      },
    };
    const { value } = backend(processes);

    await expect(value.recoverOwned()).resolves.toBe(1);
    const listing = requests[0]?.arguments ?? [];
    expect(listing).toContain(
      `label=socrates.deployment=${ownership.labels["socrates.deployment"]}`,
    );
    expect(listing).toContain(
      `label=socrates.runner=${ownership.labels["socrates.runner"]}`,
    );
    expect(listing).not.toContain("system");
    expect(listing).not.toContain("prune");
  });
});
