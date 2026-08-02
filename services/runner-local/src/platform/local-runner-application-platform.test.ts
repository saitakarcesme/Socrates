import { mkdtemp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runnerExecutionV1Schema,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import {
  encodeRuntimeMessage,
  runtimeAbi,
  runtimeFrameSchema,
  runtimeProtocolLimits,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { pack } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnerOwnershipLabels } from "../oci";
import type { ProcessRequest, ProcessResult } from "../oci";
import {
  fixtureHostReadinessProbe,
  fixtureNerdctlCommand,
  successfulResult,
} from "../oci/test-fixtures";
import { sourceSnapshotMediaType } from "../source";
import {
  LocalRunnerApplicationPlatform,
  LocalRunnerApplicationPlatformError,
  type LocalRunnerApplicationPlatformOptions,
} from "./local-runner-application-platform";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const runnerId = "10000000-0000-4000-8000-000000000001";
const credential = `srt1.90000000-0000-4000-8000-000000000009.${"a".repeat(43)}`;
const imageDigest = `sha256:${"1".repeat(64)}`;
const attemptId = "20000000-0000-4000-8000-000000000002";
const deliveryId = "40000000-0000-4000-8000-000000000004";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "socrates-application-platform-"));
  roots.push(value);
  return value;
}

function portable(path: string): string {
  return path.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/");
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return true;
    }
    throw cause;
  }
}

function configuration(parent = "/var/lib/socrates") {
  const privateRoot = portable(parent);
  return {
    version: "1",
    identity: { deploymentId: "runner-application-1", runnerId },
    controlPlane: {
      origin: "https://control.socrates.test",
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
    },
    roots: {
      artifacts: `${privateRoot}/artifacts`,
      sources: `${privateRoot}/sources`,
      journal: `${privateRoot}/journal`,
      spool: `${privateRoot}/spool`,
    },
    engine: {
      executable: "/usr/local/bin/nerdctl",
      address: "unix:///run/containerd/containerd.sock",
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
      readinessTtlMs: 30_000,
      controlTimeoutMs: 12_345,
      executionTimeoutMs: 300_000,
      maximumControlOutputBytes: 234_567,
    },
    source: {
      maximumArchiveBytes: 2_097_152,
      maximumExpandedBytes: 8_388_608,
      maximumEntries: 1_000,
      maximumFileBytes: 2_097_152,
      maximumPathBytes: 4_096,
      maximumComponentBytes: 255,
      maximumPathDepth: 64,
    },
    request: { maximumBytes: 1_048_576 },
    runtime: {
      maximumProtocolBytes: 524_288,
      maximumChildOutputBytes: 2_097_152,
    },
    execution: {
      maximumWallTimeMs: 300_000,
      maximumMemoryBytes: 1_073_741_824,
      maximumPids: 128,
      maximumWritableBytes: 1_073_741_824,
      maximumRuntimeOutputBytes: 2_097_152,
      maximumCommandCount: 3,
      temporaryBytes: 67_108_864,
      sharedMemoryBytes: 67_108_864,
      cpuQuotaPeriodMicros: 100_000,
      minimumCpuQuotaMicros: 1_000,
      maximumCpuQuotaMicros: 100_000,
    },
    durability: {
      journal: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 100,
        maximumJournalBytes: 10_000_000,
      },
      spool: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 100,
        maximumAttempts: 100,
        maximumSpoolBytes: 10_000_000,
      },
    },
    lifecycle: {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 0,
      maximumRecoveryAttempts: 1,
      pollIntervalMs: 25,
    },
  };
}

function trustedImages() {
  return {
    version: "1",
    images: [
      {
        digest: imageDigest,
        manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
        configurationDigest: `sha256:${"2".repeat(64)}`,
        architecture: "amd64",
        runtimeBuildDigest: `sha256:${"3".repeat(64)}`,
        runtimeBundleDigest: `sha256:${"4".repeat(64)}`,
        runtime: {
          executable: "/usr/local/bin/node",
          arguments: ["/opt/socrates/task-runtime.mjs"],
        },
        profileProbe: { executable: "/bin/probe", arguments: [] },
        environment: ["PATH=/usr/local/bin:/usr/bin:/bin"],
      },
    ],
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function sourceArchive(): Promise<Buffer> {
  const stream = pack();
  stream.entry(
    { name: "scripts/measure.mjs", type: "file", mode: 0o644 },
    "console.log('measured');\n",
  );
  stream.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function runtimeFrames(): RuntimeFrame[] {
  const measurement = '{"schema":"metric-value.v1","value":"1.25"}';
  return [
    { type: "command.started", phase: "action", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "action",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 4,
    },
    { type: "command.started", phase: "measurement", commandIndex: 0 },
    {
      type: "command.exited",
      phase: "measurement",
      commandIndex: 0,
      exitCode: 0,
      signal: null,
      durationMs: 5,
    },
    {
      type: "measurement.result",
      sequence: 0,
      final: true,
      bytes: Buffer.from(measurement).toString("base64"),
    },
    { type: "runtime.completed", status: "succeeded" },
  ].map((frame) => runtimeFrameSchema.parse(frame));
}

function framedResult(frames: readonly RuntimeFrame[]): ProcessResult {
  const messages = frames.map((frame) =>
    encodeRuntimeMessage(
      runtimeFrameSchema,
      frame,
      runtimeProtocolLimits.maximumFrameBytes,
    ),
  );
  const stdoutBytes = new Uint8Array(
    messages.reduce((total, message) => total + message.byteLength, 0),
  );
  let offset = 0;
  for (const message of messages) {
    stdoutBytes.set(message, offset);
    offset += message.byteLength;
  }
  return successfulResult("", { stdoutBytes, durationMs: 9 });
}

function handshakeResult(): ProcessResult {
  return framedResult([
    runtimeFrameSchema.parse({
      type: "runtime.handshake",
      abi: runtimeAbi,
      buildDigest: trustedImages().images[0]!.runtimeBuildDigest,
    }),
  ]);
}

function profileProof(): ProcessResult {
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

function compatibleImageInspection(): ProcessResult {
  const image = trustedImages().images[0]!;
  return successfulResult(
    JSON.stringify({
      Id: image.configurationDigest,
      RepoDigests: [image.digest],
      Os: "linux",
      Architecture: image.architecture,
      Config: {
        User: "65534:65534",
        Env: image.environment,
        Entrypoint: [image.runtime.executable, ...image.runtime.arguments],
        Cmd: [],
        Labels: {
          "io.socrates.task-runtime.abi": runtimeAbi,
          "io.socrates.task-runtime.build-digest": image.runtimeBuildDigest,
          "io.socrates.task-runtime.bundle-digest": image.runtimeBundleDigest,
        },
        Volumes: null,
        Healthcheck: null,
        WorkingDir: "",
        StopSignal: "",
      },
    }),
  );
}

function nativeImageInspection(): ProcessResult {
  const image = trustedImages().images[0]!;
  return successfulResult(
    JSON.stringify({
      Image: {
        Name: "registry.example/socrates/task-runtime:admitted",
        Target: {
          mediaType: image.manifestMediaType,
          digest: image.digest,
          size: 1_024,
        },
      },
      ImageConfigDesc: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: image.configurationDigest,
        size: 1_024,
      },
    }),
  );
}

function argumentAfter(arguments_: readonly string[], name: string): string {
  const index = arguments_.lastIndexOf(name);
  const value = arguments_[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`Missing create argument ${name}.`);
  }
  return value;
}

function nativeInspection(create: ProcessRequest): ProcessResult {
  const arguments_ = create.arguments;
  const tmpfs = new Map<string, readonly string[]>();
  const binds: Array<Record<string, unknown>> = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--tmpfs") {
      const candidate = arguments_[index + 1]!;
      const [destination, ...options] = candidate.split(":");
      tmpfs.set(destination!, options.join(":").split(","));
    }
    if (arguments_[index] === "--mount") {
      const entries = Object.fromEntries(
        arguments_[index + 1]!.split(",").map((entry) => {
          const separator = entry.indexOf("=");
          return separator < 0
            ? [entry, true]
            : [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      );
      binds.push({
        destination: entries["dst"],
        source: entries["src"],
        type: "bind",
        options: ["rbind", "rro", "rprivate"],
      });
    }
  }
  const mounts = [...tmpfs].map(([destination, options]) => ({
    destination,
    type: "tmpfs",
    options,
  }));
  return successfulResult(
    JSON.stringify([
      {
        Spec: {
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
          mounts: [...mounts, ...binds],
          linux: {
            namespaces: [
              "mount",
              "pid",
              "ipc",
              "user",
              "cgroup",
              "network",
            ].map((type) => ({ type })),
            resources: {
              memory: {
                limit: Number(argumentAfter(arguments_, "--memory")),
                swap: Number(argumentAfter(arguments_, "--memory-swap")),
              },
              cpu: {
                quota: Math.round(
                  Number(argumentAfter(arguments_, "--cpus")) * 100_000,
                ),
                period: 100_000,
              },
              pids: {
                limit: Number(argumentAfter(arguments_, "--pids-limit")),
              },
            },
          },
        },
      },
    ]),
  );
}

async function measuredHarness(parent: string, controller: AbortController) {
  const archiveBytes = await sourceArchive();
  const sourceDigest = digest(archiveBytes);
  const task = structuredClone(taskFixture);
  task.source.digest = sourceDigest;
  task.environment.imageDigest = imageDigest;
  const execution = runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId,
      taskId: task.taskId,
      attemptId,
      fence: 4,
      leasedUntil: "2026-08-02T02:00:00.000Z",
    },
    task,
  });
  const delivery: RunnerTaskDeliveryV1 = {
    version: "1",
    deliveryId,
    taskId: task.taskId,
  };
  const paths: string[] = [];
  const submitted: unknown[] = [];
  let acquired = false;
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    paths.push(url.pathname);
    if (url.pathname.endsWith("/task-deliveries/acquire")) {
      if (!acquired) {
        acquired = true;
        return jsonResponse({ version: "1", delivery });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith(`/task-deliveries/${deliveryId}/claims`)) {
      return jsonResponse({ version: "1", execution });
    }
    if (url.pathname.endsWith("/heartbeat")) {
      return jsonResponse({
        version: "1",
        leaseExpiresAt: "2026-08-02T02:00:30.000Z",
        directive: "continue",
      });
    }
    if (url.pathname.endsWith("/source-snapshots/resolve")) {
      return new Response(archiveBytes, {
        headers: {
          "content-length": String(archiveBytes.byteLength),
          "content-type": sourceSnapshotMediaType,
        },
      });
    }
    if (url.pathname.endsWith("/events")) {
      const candidate = body as {
        event: { eventId: string; attemptId: string; sequence: number };
      };
      submitted.push(candidate.event);
      return jsonResponse({
        version: "1",
        replay: false,
        acknowledgement: {
          version: "1",
          eventId: candidate.event.eventId,
          attemptId: candidate.event.attemptId,
          acknowledgedSequence: candidate.event.sequence,
          expectedSequence: candidate.event.sequence + 1,
          receivedAt: "2026-08-02T00:00:02.000Z",
        },
      });
    }
    throw new Error(`Unexpected measured route ${url.pathname}.`);
  });
  const processRequests: ProcessRequest[] = [];
  let activeName = "";
  let activeLabels: Record<string, string> = {};
  let activeCreate: ProcessRequest | undefined;
  let starts = 0;
  const run = vi.fn(async (request: ProcessRequest) => {
    processRequests.push(request);
    const command = fixtureNerdctlCommand(request);
    if (command === "ps") return successfulResult();
    if (command === "image") {
      return request.arguments.includes("dockercompat")
        ? compatibleImageInspection()
        : nativeImageInspection();
    }
    if (command === "version") {
      return successfulResult(
        JSON.stringify({
          Client: { Version: "2.3.1" },
          Server: { Version: "2.1.4" },
        }),
      );
    }
    if (command === "info") {
      return successfulResult(
        JSON.stringify({
          SecurityOptions: ["name=rootless", "name=seccomp"],
          Architecture: "amd64",
          CgroupVersion: "2",
        }),
      );
    }
    if (command === "create") {
      activeCreate = request;
      activeName = argumentAfter(request.arguments, "--name");
      activeLabels = {};
      for (let index = 0; index < request.arguments.length; index += 1) {
        if (request.arguments[index] !== "--label") continue;
        const label = request.arguments[index + 1]!;
        const separator = label.indexOf("=");
        activeLabels[label.slice(0, separator)] = label.slice(separator + 1);
      }
      return successfulResult();
    }
    if (command === "inspect" && request.arguments.includes("--help")) {
      return successfulResult("--mode native");
    }
    if (command === "inspect" && request.arguments.includes("--mode")) {
      if (!activeCreate) throw new Error("Missing active create request.");
      return nativeInspection(activeCreate);
    }
    if (command === "inspect") {
      return successfulResult(
        JSON.stringify({
          Name: activeName,
          Image: imageDigest,
          Config: { Image: imageDigest, Labels: activeLabels },
        }),
      );
    }
    if (command === "start") {
      starts += 1;
      if (starts === 1 || starts === 3) return profileProof();
      if (starts === 2) return handshakeResult();
      if (starts === 4) return framedResult(runtimeFrames());
    }
    if (command === "rm") return successfulResult();
    throw new Error(`Unexpected measured process command ${String(command)}.`);
  });
  let epoch = 1_785_620_000_000;
  let probe = 4;
  let monotonic = 10;
  let event = 1;
  const observed: unknown[] = [];
  const options = {
    configuration: configuration(parent),
    trustedImages: trustedImages(),
    credential,
    fetch: fetchImplementation,
    processes: { run },
    host: {
      inspect: vi.fn(async () => ({
        ...fixtureHostReadinessProbe,
      })),
    },
    clock: { now: vi.fn(() => epoch++) },
    probeIdentities: {
      next: vi.fn(() => {
        const value = probe;
        probe += 2;
        return {
          taskId: `${value}0000000-0000-4000-8000-00000000000${value}`,
          attemptId: `${value + 1}0000000-0000-4000-8000-00000000000${value + 1}`,
        };
      }),
    },
    scheduler: {
      wait: vi.fn(
        async (_delay: number, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    },
    time: { now: vi.fn(() => (monotonic += 3)) },
    observer: {
      observe: vi.fn(async (result) => {
        observed.push(result);
        if (result.state === "settled") {
          controller.abort(Symbol("measured application stop"));
        }
      }),
    },
    journalIdentity: {
      attemptId: vi.fn(() => attemptId),
      now: vi.fn(() => new Date("2026-08-02T00:00:00.000Z")),
    },
    spoolIdentity: {
      eventId: vi.fn(
        () =>
          `30000000-0000-4000-8000-${(event++).toString(16).padStart(12, "0")}`,
      ),
      now: vi.fn(() => new Date("2026-08-02T00:00:01.000Z")),
    },
    directorySync: { sync: vi.fn(async () => undefined) },
  } satisfies LocalRunnerApplicationPlatformOptions;
  return {
    observed,
    options,
    paths,
    processRequests,
    starts: () => starts,
    submitted,
  };
}

function harness(parent = "/var/lib/socrates") {
  const requests: ProcessRequest[] = [];
  const order: string[] = [];
  const run = vi.fn(async (request: ProcessRequest): Promise<ProcessResult> => {
    order.push("oci.recover");
    requests.push(request);
    return successfulResult();
  });
  const inspect = vi.fn(async () => ({
    ...fixtureHostReadinessProbe,
  }));
  const epochNow = vi.fn(() => 1_785_620_000_000);
  let probe = 4;
  const nextProbe = vi.fn(() => {
    const value = probe;
    probe += 2;
    return {
      taskId: `${value}0000000-0000-4000-8000-00000000000${value}`,
      attemptId: `${value + 1}0000000-0000-4000-8000-00000000000${value + 1}`,
    };
  });
  const fetchImplementation = vi.fn<typeof fetch>(async () => {
    order.push("control.acquire");
    return new Response(null, { status: 204 });
  });
  const wait = vi.fn(async (_delayMs: number, signal: AbortSignal) => {
    order.push("dispatch.wait");
    return new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  let monotonic = 10;
  const now = vi.fn(() => {
    const value = monotonic;
    monotonic += 3;
    return value;
  });
  const observe = vi.fn(async () => {
    order.push("dispatch.observe");
  });
  const journalAttemptId = vi.fn(() => "20000000-0000-4000-8000-000000000002");
  const journalNow = vi.fn(() => new Date("2026-08-02T00:00:00.000Z"));
  const eventId = vi.fn(() => "30000000-0000-4000-8000-000000000003");
  const spoolNow = vi.fn(() => new Date("2026-08-02T00:00:01.000Z"));
  const sync = vi.fn(async () => undefined);
  const options = {
    configuration: configuration(parent),
    trustedImages: trustedImages(),
    credential,
    fetch: fetchImplementation,
    processes: { run },
    host: { inspect },
    clock: { now: epochNow },
    probeIdentities: { next: nextProbe },
    scheduler: { wait },
    time: { now },
    observer: { observe },
    journalIdentity: { attemptId: journalAttemptId, now: journalNow },
    spoolIdentity: { eventId, now: spoolNow },
    directorySync: { sync },
  } satisfies LocalRunnerApplicationPlatformOptions;
  return {
    epochNow,
    eventId,
    fetchImplementation,
    inspect,
    journalAttemptId,
    nextProbe,
    now,
    observe,
    options,
    order,
    requests,
    run,
    spoolNow,
    sync,
    wait,
  };
}

function failure(candidate: unknown): LocalRunnerApplicationPlatformError {
  try {
    new LocalRunnerApplicationPlatform(
      candidate as LocalRunnerApplicationPlatformOptions,
    );
  } catch (cause) {
    if (cause instanceof LocalRunnerApplicationPlatformError) return cause;
    throw cause;
  }
  throw new Error("Expected application platform construction to fail.");
}

function effectSpies(value: ReturnType<typeof harness>) {
  return [
    value.run,
    value.inspect,
    value.epochNow,
    value.nextProbe,
    value.fetchImplementation,
    value.wait,
    value.now,
    value.observe,
    value.journalAttemptId,
    value.eventId,
    value.spoolNow,
    value.sync,
  ];
}

describe("local runner application platform composition", () => {
  it("admits configuration before images, credential, and dependencies", () => {
    const reads: PropertyKey[] = [];
    const candidate = new Proxy(
      { configuration: { private: "invalid configuration" } },
      {
        get(target, property, receiver) {
          if (property === "configuration") {
            reads.push(property);
            return Reflect.get(target, property, receiver);
          }
          reads.push(property);
          throw new Error("private later getter");
        },
      },
    );

    expect(failure(candidate)).toMatchObject({
      code: "invalid_configuration",
      message: "Local runner application configuration is invalid.",
    });
    expect(reads).toEqual(["configuration"]);
  });

  it("admits images before credential and dependencies", () => {
    const reads: PropertyKey[] = [];
    const candidate = new Proxy(
      {
        configuration: configuration(),
        trustedImages: { private: "invalid images" },
      },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (property === "configuration" || property === "trustedImages") {
            return Reflect.get(target, property, receiver);
          }
          throw new Error("private later getter");
        },
      },
    );

    expect(failure(candidate)).toMatchObject({ code: "invalid_images" });
    expect(reads).toEqual(["configuration", "trustedImages"]);
  });

  it("admits credential before every dependency", () => {
    const reads: PropertyKey[] = [];
    const candidate = new Proxy(
      {
        configuration: configuration(),
        trustedImages: trustedImages(),
        credential: "private invalid credential",
      },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (
            property === "configuration" ||
            property === "trustedImages" ||
            property === "credential"
          ) {
            return Reflect.get(target, property, receiver);
          }
          throw new Error("private dependency getter");
        },
      },
    );

    expect(failure(candidate)).toMatchObject({ code: "invalid_credential" });
    expect(reads).toEqual(["configuration", "trustedImages", "credential"]);
  });

  it("captures dependencies only after every input is admitted", () => {
    const value = harness();
    let processReads = 0;
    const candidate = Object.defineProperties(
      { ...value.options, fetch: undefined },
      {
        processes: {
          enumerable: true,
          get: () => {
            processReads += 1;
            return value.options.processes;
          },
        },
      },
    );

    expect(failure(candidate)).toMatchObject({ code: "invalid_dependency" });
    expect(processReads).toBe(0);
    for (const effect of effectSpies(value))
      expect(effect).not.toHaveBeenCalled();
  });

  it("constructs one frozen opaque graph without external effects", async () => {
    const parent = await root();
    const value = harness(parent);
    const platform = new LocalRunnerApplicationPlatform(value.options);

    expect(Object.isFrozen(platform)).toBe(true);
    expect(Object.keys(platform)).toEqual([]);
    expect(JSON.stringify(platform)).toBe("{}");
    for (const effect of effectSpies(value))
      expect(effect).not.toHaveBeenCalled();
    for (const path of Object.values(value.options.configuration.roots)) {
      await expect(absent(path)).resolves.toBe(true);
    }
  });

  it("reads every admitted option and dependency method exactly once", () => {
    const value = harness();
    const optionReads = new Map<PropertyKey, number>();
    const methodReads = new Map<string, number>();
    const owners = [
      ["processes", value.options.processes, ["run"]],
      ["host", value.options.host, ["inspect"]],
      ["clock", value.options.clock, ["now"]],
      ["probeIdentities", value.options.probeIdentities, ["next"]],
      ["scheduler", value.options.scheduler, ["wait"]],
      ["time", value.options.time, ["now"]],
      ["observer", value.options.observer, ["observe"]],
      ["journalIdentity", value.options.journalIdentity, ["attemptId", "now"]],
      ["spoolIdentity", value.options.spoolIdentity, ["eventId", "now"]],
      ["directorySync", value.options.directorySync, ["sync"]],
    ] as const;
    for (const [ownerName, owner, methods] of owners) {
      for (const method of methods) {
        const original = owner[method as keyof typeof owner];
        const key = `${ownerName}.${method}`;
        Object.defineProperty(owner, method, {
          configurable: true,
          get: () => {
            methodReads.set(key, (methodReads.get(key) ?? 0) + 1);
            return original;
          },
        });
      }
    }
    const options = new Proxy(value.options, {
      get(target, property, receiver) {
        optionReads.set(property, (optionReads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });

    new LocalRunnerApplicationPlatform(options);

    expect(Object.fromEntries(optionReads)).toEqual({
      clock: 1,
      configuration: 1,
      credential: 1,
      directorySync: 1,
      fetch: 1,
      host: 1,
      journalIdentity: 1,
      observer: 1,
      probeIdentities: 1,
      processes: 1,
      scheduler: 1,
      spoolIdentity: 1,
      time: 1,
      trustedImages: 1,
    });
    expect([...methodReads.values()].every((count) => count === 1)).toBe(true);
    expect(methodReads.size).toBe(12);
    for (const effect of effectSpies(value))
      expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    ["fetch", { fetch: true }],
    ["process", { processes: { run: true } }],
    ["host", { host: { inspect: true } }],
    ["clock", { clock: { now: true } }],
    ["probe identity", { probeIdentities: { next: true } }],
    ["scheduler", { scheduler: { wait: true } }],
    ["time", { time: { now: true } }],
    ["observer", { observer: { observe: true } }],
    ["journal identity", { journalIdentity: { attemptId: true, now: true } }],
    ["spool identity", { spoolIdentity: { eventId: true, now: true } }],
    ["directory sync", { directorySync: { sync: true } }],
  ])(
    "rejects a non-callable %s capability without effects",
    (_name, override) => {
      const value = harness();
      const error = failure({ ...value.options, ...override });

      expect(error).toMatchObject({ code: "invalid_dependency" });
      expect("cause" in error).toBe(false);
      for (const effect of effectSpies(value))
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid_configuration", { configuration: { secret: "config-secret" } }],
    ["invalid_images", { trustedImages: { secret: "image-secret" } }],
    ["invalid_credential", { credential: "credential-secret" }],
    ["invalid_dependency", { fetch: "dependency-secret" }],
  ])("returns cause-free redacted %s errors", (code, override) => {
    const value = harness();
    const error = failure({ ...value.options, ...override });
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(error.code).toBe(code);
    expect("cause" in error).toBe(false);
    expect(rendered).not.toMatch(
      /config-secret|image-secret|credential-secret|dependency-secret/u,
    );
  });

  it("captures every authority and owns one authenticated idle run", async () => {
    const parent = await root();
    const value = harness(parent);
    const controller = new AbortController();
    const reason = Symbol("application platform stop");
    const original = {
      fetch: value.options.fetch,
      observe: value.options.observer.observe,
      run: value.options.processes.run,
      wait: value.options.scheduler.wait,
    };
    value.options.scheduler.wait = vi.fn(async (_delay, signal) => {
      controller.abort(reason);
      return Promise.reject(signal.reason);
    });
    const admittedWait = value.options.scheduler.wait;
    const platform = new LocalRunnerApplicationPlatform(value.options);
    value.options.fetch = vi.fn(async () => {
      throw new Error("mutated fetch");
    });
    value.options.processes.run = vi.fn(async () => {
      throw new Error("mutated process");
    });
    value.options.observer.observe = vi.fn(async () => {
      throw new Error("mutated observer");
    });
    value.options.scheduler.wait = vi.fn(async () => {
      throw new Error("mutated scheduler");
    });
    value.options.configuration.identity.runnerId =
      "ffffffff-ffff-4fff-8fff-ffffffffffff";

    const first = platform.run(controller.signal);
    const second = platform.run(controller.signal);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ state: "stopped" });
    expect(original.run).toHaveBeenCalledOnce();
    expect(original.fetch).toHaveBeenCalledOnce();
    expect(original.observe).toHaveBeenCalledWith({ state: "idle" });
    expect(admittedWait).toHaveBeenCalledWith(25, controller.signal);
    expect(value.requests[0]).toMatchObject({
      executable: "/usr/local/bin/nerdctl",
      timeoutMs: 12_345,
      maximumOutputBytes: 234_567,
    });
    for (const [name, label] of Object.entries(
      runnerOwnershipLabels("runner-application-1", runnerId),
    )) {
      expect(value.requests[0]?.arguments).toContain(`label=${name}=${label}`);
    }
    const [url, request] = original.fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://control.socrates.test/v1/runner/task-deliveries/acquire",
    );
    expect(new Headers(request?.headers).get("authorization")).toBe(
      `Bearer ${credential}`,
    );
    expect(value.order).toEqual([
      "oci.recover",
      "control.acquire",
      "dispatch.observe",
    ]);
  });

  it("stops a pre-aborted first run without invoking the graph", async () => {
    const parent = await root();
    const value = harness(parent);
    const platform = new LocalRunnerApplicationPlatform(value.options);
    const controller = new AbortController();
    controller.abort(Object.freeze({ private: "shutdown" }));

    await expect(platform.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    for (const effect of effectSpies(value))
      expect(effect).not.toHaveBeenCalled();
  });

  it("retains one fail-stop operation after a transport failure", async () => {
    const parent = await root();
    const value = harness(parent);
    const unavailable = vi.fn<typeof fetch>(async () => {
      throw new Error("control plane unavailable");
    });
    value.options.fetch = unavailable;
    const platform = new LocalRunnerApplicationPlatform(value.options);
    const controller = new AbortController();

    const first = platform.run(controller.signal);
    const second = platform.run(controller.signal);
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "dispatch_failed" });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(value.run).toHaveBeenCalledOnce();
  });

  it("runs one measured attempt through the shared image and sandbox graph", async () => {
    const parent = await root();
    const controller = new AbortController();
    const value = await measuredHarness(parent, controller);
    const platform = new LocalRunnerApplicationPlatform(value.options);
    value.options.trustedImages.images[0]!.digest = `sha256:${"f".repeat(64)}`;

    await expect(platform.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    expect(value.observed).toHaveLength(1);
    expect(value.observed[0]).toMatchObject({
      state: "settled",
      path: "fresh",
      deliveryId,
      result: {
        state: "completed",
        publication: { state: "completed", publication: "appended" },
        authority: { state: "stopped" },
      },
    });
    expect(value.paths).toContain("/v1/runner/task-deliveries/acquire");
    expect(value.paths).toContain(
      `/v1/runner/task-deliveries/${deliveryId}/claims`,
    );
    expect(value.paths).toContain(
      `/v1/runner/tasks/${taskFixture.taskId}/attempts/${attemptId}/source-snapshots/resolve`,
    );
    expect(value.paths.filter((path) => path.endsWith("/events"))).toHaveLength(
      5,
    );
    expect(value.submitted).toContainEqual(
      expect.objectContaining({ type: "task.succeeded" }),
    );
    expect(value.starts()).toBe(4);
    expect(
      value.processRequests.filter(
        (request) => fixtureNerdctlCommand(request) === "image",
      ),
    ).toHaveLength(2);
    expect(
      value.processRequests.filter(
        (request) => fixtureNerdctlCommand(request) === "create",
      ),
    ).toHaveLength(4);
    expect(
      value.processRequests.filter(
        (request) => fixtureNerdctlCommand(request) === "start",
      ),
    ).toHaveLength(4);
  }, 15_000);
});
