import { describe, expect, it } from "vitest";

import { NerdctlSandboxBackend, sandboxTerminationReceipt } from "./backend";
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
import { issueMaterializedRuntimeRequest } from "../request/capability";
import { ProcessExecutionError } from "./process";

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
  private requestPath: string | undefined;

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
      const requestMount = request.arguments.find((argument) =>
        argument.includes("dst=/socrates/request.bin"),
      );
      this.requestPath = requestMount
        ?.split(",")
        .find((entry) => entry.startsWith("src="))
        ?.slice(4);
      return successfulResult();
    }
    if (command === "inspect" && request.arguments.includes("--mode")) {
      const native = JSON.parse(fixtureNativeInspection()) as Array<{
        Spec: { mounts: Record<string, unknown>[] };
      }>;
      if (this.requestPath) {
        native[0]?.Spec.mounts.push({
          destination: "/socrates/request.bin",
          source: this.requestPath,
          type: "bind",
          options: ["rbind", "rro", "rprivate"],
        });
      }
      return successfulResult(JSON.stringify(native));
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

function cancellationHarness(
  wait: "error" | "success" | "timeout",
  options: {
    disappearOnWait?: boolean;
    disappearOnKill?: boolean;
    failGraceful?: boolean;
    failKill?: boolean;
    failRemoval?: boolean;
  } = {},
) {
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
      if (command === "inspect") {
        return successfulResult(compatibleInspection);
      }
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
      if (
        command === "kill" &&
        request.arguments.includes("TERM") &&
        options.failGraceful
      ) {
        return successfulResult("", {
          exitCode: 1,
          stderr: "graceful termination failed",
        });
      }
      if (command === "wait" && wait === "timeout") {
        throw new ProcessExecutionError(
          "timeout",
          "Graceful termination did not finish in time.",
        );
      }
      if (command === "wait" && wait === "error") {
        throw new Error("unclassified wait failure");
      }
      if (command === "wait" && options.disappearOnWait) {
        return successfulResult("", {
          exitCode: 1,
          stderr: "no such container",
        });
      }
      if (
        command === "kill" &&
        request.arguments.includes("KILL") &&
        options.disappearOnKill
      ) {
        return successfulResult("", {
          exitCode: 1,
          stderr: "no such container",
        });
      }
      if (
        command === "kill" &&
        request.arguments.includes("KILL") &&
        options.failKill
      ) {
        return successfulResult("", {
          exitCode: 1,
          stderr: "forced termination failed",
        });
      }
      if (
        command === "rm" &&
        options.failRemoval &&
        request.arguments.includes(
          createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
        )
      ) {
        return successfulResult("", {
          exitCode: 1,
          stderr: "owned removal failed",
        });
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
  return { execution, requests, running, started, value };
}

describe("nerdctl sandbox backend", () => {
  it("validates and freezes exact termination receipts", () => {
    const absent = sandboxTerminationReceipt({ state: "absent" });
    const terminated = sandboxTerminationReceipt({
      state: "terminated",
      forced: true,
    });

    expect(absent).toEqual({ state: "absent" });
    expect(terminated).toEqual({ state: "terminated", forced: true });
    expect(Object.isFrozen(absent)).toBe(true);
    expect(Object.isFrozen(terminated)).toBe(true);
    for (const invalid of [
      null,
      { state: "absent", forced: false },
      { state: "terminated" },
      { state: "terminated", forced: "true" },
    ]) {
      expect(() => sandboxTerminationReceipt(invalid)).toThrow(TypeError);
    }
  });

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

  it("mounts an owned runtime request before attached start", async () => {
    const processes = new LifecycleProcesses();
    const { value } = backend(processes);
    const request = issueMaterializedRuntimeRequest({
      path: "/runner/sources/runtime/request.bin",
      deploymentId,
      identity: fixtureIdentity,
      digest: `sha256:${"c".repeat(64)}`,
      sizeBytes: 128,
    });

    await value.executeRuntime({
      identity: fixtureIdentity,
      image: fixtureImage,
      profile: fixtureProfile,
      request: { envelope: request, expectedDigest: request.digest },
    });

    const creates = processes.requests.filter(
      (request) => request.arguments[0] === "create",
    );
    const starts = processes.requests.filter(
      (request) => request.arguments[0] === "start",
    );
    expect(creates[0]?.arguments).not.toContain("--interactive");
    expect(creates[1]?.arguments).not.toContain("--interactive");
    expect(creates[1]?.arguments).toContain(
      "type=bind,src=/runner/sources/runtime/request.bin,dst=/socrates/request.bin,rro,bind-propagation=rprivate",
    );
    expect(starts[0]?.stdin).toBeUndefined();
    expect(starts[1]?.arguments).toEqual([
      "start",
      "--attach",
      createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
    ]);
    expect(starts[1]?.stdin).toBeUndefined();
    expect(
      processes.requests.some((entry) => entry.arguments[0] === "attach"),
    ).toBe(false);
  });

  it("rejects a materialized request with a different expected digest", async () => {
    const processes = new LifecycleProcesses();
    const { value } = backend(processes);
    const request = issueMaterializedRuntimeRequest({
      path: "/runner/sources/runtime/request.bin",
      deploymentId,
      identity: fixtureIdentity,
      digest: `sha256:${"c".repeat(64)}`,
      sizeBytes: 128,
    });

    await expect(
      value.executeRuntime({
        identity: fixtureIdentity,
        image: fixtureImage,
        profile: fixtureProfile,
        request: {
          envelope: request,
          expectedDigest: `sha256:${"d".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/request digest/u);
    expect(processes.requests).toEqual([]);
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
    ).resolves.toEqual({ state: "absent" });
    expect(processes.requests).toHaveLength(0);
  });

  it("returns graceful termination without issuing kill", async () => {
    const value = cancellationHarness("success");
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "terminated",
      forced: false,
    });
    expect(
      value.requests
        .filter((request) =>
          ["kill", "wait"].includes(String(request.arguments[0])),
        )
        .map((request) => request.arguments),
    ).toEqual([
      [
        "kill",
        "--signal",
        "TERM",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
      [
        "wait",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
    ]);
    value.execution.resolve(
      successfulResult("", { exitCode: 143, signal: "SIGTERM" }),
    );
    await expect(value.running).resolves.toMatchObject({ exitCode: 143 });
  });

  it("escalates cancellation only for the exact active fence", async () => {
    const value = cancellationHarness("timeout");
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "terminated",
      forced: true,
    });
    expect(
      value.requests
        .filter((request) =>
          ["kill", "wait"].includes(String(request.arguments[0])),
        )
        .map((request) => request.arguments),
    ).toEqual([
      [
        "kill",
        "--signal",
        "TERM",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
      [
        "wait",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
      [
        "kill",
        "--signal",
        "KILL",
        createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
      ],
    ]);

    value.execution.resolve(
      successfulResult("", {
        exitCode: 137,
        signal: "SIGKILL",
      }),
    );
    await expect(value.running).resolves.toMatchObject({ exitCode: 137 });
  });

  it("escalates after an authoritative graceful request failure", async () => {
    const value = cancellationHarness("success", { failGraceful: true });
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "terminated",
      forced: true,
    });
    expect(
      value.requests
        .filter(({ arguments: arguments_ }) => arguments_[0] === "kill")
        .map(({ arguments: arguments_ }) => arguments_[2]),
    ).toEqual(["TERM", "KILL"]);
    expect(
      value.requests.filter(
        ({ arguments: arguments_ }) => arguments_[0] === "wait",
      ),
    ).toHaveLength(0);
    value.execution.resolve(
      successfulResult("", { exitCode: 137, signal: "SIGKILL" }),
    );
    await value.running;
  });

  it("classifies disappearance during graceful wait as absent", async () => {
    const value = cancellationHarness("success", { disappearOnWait: true });
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "absent",
    });
    expect(
      value.requests.filter(({ arguments: arguments_ }) =>
        arguments_.includes("KILL"),
      ),
    ).toHaveLength(0);
    value.execution.resolve(
      successfulResult("", { exitCode: 0, signal: null }),
    );
    await value.running;
  });

  it("uses immediate forced termination for zero grace", async () => {
    const value = cancellationHarness("success");
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 0)).resolves.toEqual({
      state: "terminated",
      forced: true,
    });
    expect(
      value.requests
        .filter(({ arguments: arguments_ }) => arguments_[0] === "kill")
        .map(({ arguments: arguments_ }) => arguments_[2]),
    ).toEqual(["KILL"]);
    value.execution.resolve(
      successfulResult("", { exitCode: 137, signal: "SIGKILL" }),
    );
    await value.running;
  });

  it("classifies disappearance during forced termination as absent", async () => {
    const value = cancellationHarness("timeout", { disappearOnKill: true });
    await value.started.promise;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "absent",
    });
    expect(
      value.requests
        .filter(({ arguments: arguments_ }) => arguments_[0] === "kill")
        .map(({ arguments: arguments_ }) => arguments_[2]),
    ).toEqual(["TERM", "KILL"]);
    value.execution.resolve(successfulResult("", { exitCode: 0 }));
    await value.running;
  });

  it("rejects unclassified wait failure after one safety escalation", async () => {
    const value = cancellationHarness("error");
    await value.started.promise;

    await expect(
      value.value.cancel(fixtureIdentity, 1_500),
    ).rejects.toMatchObject({
      code: "engine",
      message: "Sandbox cancellation became uncertain.",
    });
    expect(
      value.requests
        .filter(({ arguments: arguments_ }) => arguments_[0] === "kill")
        .map(({ arguments: arguments_ }) => arguments_[2]),
    ).toEqual(["TERM", "KILL"]);
    value.execution.resolve(
      successfulResult("", { exitCode: 137, signal: "SIGKILL" }),
    );
    await value.running;
  });

  it("rejects failed escalation without producing a receipt", async () => {
    const value = cancellationHarness("timeout", { failKill: true });
    await value.started.promise;

    await expect(
      value.value.cancel(fixtureIdentity, 1_500),
    ).rejects.toMatchObject({
      code: "engine",
      message: "Sandbox cancellation became uncertain.",
    });
    expect(
      value.requests.filter(
        ({ arguments: arguments_ }) =>
          arguments_[0] === "rm" &&
          arguments_.includes(
            createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
          ),
      ),
    ).toHaveLength(1);
    value.execution.resolve(
      successfulResult("", { exitCode: 137, signal: "SIGKILL" }),
    );
    await value.running;
  });

  it("does not kill after graceful termination when cleanup fails", async () => {
    const value = cancellationHarness("success", { failRemoval: true });
    await value.started.promise;

    await expect(
      value.value.cancel(fixtureIdentity, 1_500),
    ).rejects.toMatchObject({
      code: "engine",
      message: "Sandbox cancellation became uncertain.",
    });
    expect(
      value.requests.filter(({ arguments: arguments_ }) =>
        arguments_.includes("KILL"),
      ),
    ).toHaveLength(0);
    expect(
      value.requests.filter(
        ({ arguments: arguments_ }) =>
          arguments_[0] === "rm" &&
          arguments_.includes(
            createSandboxOwnership(deploymentId, fixtureIdentity).containerName,
          ),
      ),
    ).toHaveLength(1);
    const settled = value.running.catch(() => undefined);
    value.execution.resolve(
      successfulResult("", { exitCode: 143, signal: "SIGTERM" }),
    );
    await settled;
  });

  it("returns absent when natural completion wins the cleanup race", async () => {
    const value = cancellationHarness("success");
    await value.started.promise;
    value.execution.resolve(successfulResult("", { exitCode: 0 }));
    await value.running;
    const effectsBeforeCancellation = value.requests.length;

    await expect(value.value.cancel(fixtureIdentity, 1_500)).resolves.toEqual({
      state: "absent",
    });
    expect(value.requests).toHaveLength(effectsBeforeCancellation);
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
