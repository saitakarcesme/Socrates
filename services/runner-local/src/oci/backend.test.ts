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

import type { ProcessExecutor, ProcessRequest, ProcessResult } from "./process";
import type { ReadinessVerifier } from "./readiness";

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
          }),
        );
      }
      return successfulResult("ok", { durationMs: 17 });
    }
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
