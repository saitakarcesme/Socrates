import {
  encodeRuntimeMessage,
  runtimeAbi,
  runtimeFrameSchema,
  runtimeProtocolLimits,
} from "@socrates/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  deriveLocalRunnerOciPlatformPolicy,
  deriveLocalRunnerProbeProfile,
  LocalRunnerOciPlatform,
  LocalRunnerOciPlatformError,
} from "./local-runner-oci-platform";
import { parseLocalRunnerConfiguration } from "../configuration";
import { createAdmittedImageForTesting } from "../image/testing";
import { createSandboxOwnership } from "../oci/identity";
import {
  fixtureIdentity,
  fixtureNativeInspection,
  fixtureProfile,
  successfulResult,
} from "../oci/test-fixtures";

import type {
  HostReadinessInspector,
  ProcessExecutor,
  ProcessRequest,
  ProcessResult,
} from "../oci";

const imageDigest = `sha256:${"1".repeat(64)}`;

function runnerConfiguration() {
  return {
    version: "1",
    identity: {
      deploymentId: "runner-prod-1",
      runnerId: fixtureIdentity.runnerId,
    },
    controlPlane: {
      origin: "https://control.socrates.test",
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
    },
    roots: {
      artifacts: "/var/lib/socrates/artifacts",
      sources: "/var/lib/socrates/sources",
      journal: "/var/lib/socrates/journal",
      spool: "/var/lib/socrates/spool",
    },
    engine: {
      executable: "configured-nerdctl",
      readinessTtlMs: 30_000,
      controlTimeoutMs: 12_345,
      executionTimeoutMs: 300_000,
      maximumControlOutputBytes: 234_567,
    },
    source: {
      maximumArchiveBytes: 16_777_216,
      maximumExpandedBytes: 67_108_864,
      maximumEntries: 10_000,
      maximumFileBytes: 16_777_216,
      maximumPathBytes: 4_096,
      maximumComponentBytes: 255,
      maximumPathDepth: 64,
    },
    request: { maximumBytes: 1_048_576 },
    runtime: {
      maximumProtocolBytes: runtimeProtocolLimits.maximumFrameBytes + 4,
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
      sharedMemoryBytes: 33_554_432,
      cpuQuotaPeriodMicros: 100_000,
      minimumCpuQuotaMicros: 1_000,
      maximumCpuQuotaMicros: 100_000,
    },
    durability: {
      journal: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 10_000,
        maximumJournalBytes: 1_000_000_000,
      },
      spool: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 1_000,
        maximumAttempts: 10_000,
        maximumSpoolBytes: 1_000_000_000,
      },
    },
    lifecycle: {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 5_000,
      maximumRecoveryAttempts: 3,
      pollIntervalMs: 1_000,
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

function processResult(
  stdout = "",
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return successfulResult(stdout, overrides);
}

function admissionRunnerConfiguration() {
  const configuration = runnerConfiguration();
  configuration.execution.maximumMemoryBytes = fixtureProfile.memoryBytes;
  configuration.execution.maximumPids = fixtureProfile.maximumPids;
  configuration.execution.maximumWritableBytes =
    fixtureProfile.workspaceBytes +
    fixtureProfile.temporaryBytes +
    fixtureProfile.sharedMemoryBytes;
  configuration.execution.temporaryBytes = fixtureProfile.temporaryBytes;
  configuration.execution.sharedMemoryBytes = fixtureProfile.sharedMemoryBytes;
  configuration.execution.minimumCpuQuotaMicros = 50_000;
  return configuration;
}

function imageCompatibleInspection(): ProcessResult {
  const declaration = trustedImages().images[0];
  return processResult(
    JSON.stringify({
      Id: declaration.configurationDigest,
      RepoDigests: [declaration.digest],
      Os: "linux",
      Architecture: declaration.architecture,
      Config: {
        User: "65534:65534",
        Env: declaration.environment,
        Entrypoint: [
          declaration.runtime.executable,
          ...declaration.runtime.arguments,
        ],
        Cmd: [],
        Labels: {
          "io.socrates.task-runtime.abi": runtimeAbi,
          "io.socrates.task-runtime.build-digest":
            declaration.runtimeBuildDigest,
          "io.socrates.task-runtime.bundle-digest":
            declaration.runtimeBundleDigest,
        },
        Volumes: null,
        Healthcheck: null,
        WorkingDir: "",
        StopSignal: "",
      },
    }),
  );
}

function imageNativeInspection(): ProcessResult {
  const declaration = trustedImages().images[0];
  return processResult(
    JSON.stringify({
      Image: {
        Name: "registry.example/socrates/task-runtime:admitted",
        Target: {
          mediaType: declaration.manifestMediaType,
          digest: declaration.digest,
          size: 1_024,
        },
      },
      ImageConfigDesc: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: declaration.configurationDigest,
        size: 1_024,
      },
    }),
  );
}

function handshakeResult(): ProcessResult {
  const bytes = encodeRuntimeMessage(
    runtimeFrameSchema,
    {
      type: "runtime.handshake",
      abi: runtimeAbi,
      buildDigest: trustedImages().images[0].runtimeBuildDigest,
    },
    runtimeProtocolLimits.maximumFrameBytes,
  );
  return processResult("", { stdoutBytes: bytes });
}

function dependencies(run = vi.fn(async () => processResult())) {
  const inspect = vi.fn(async () => ({
    platform: "linux" as const,
    uid: 1_000,
    cgroupControllers: ["cpu", "memory", "pids"],
    appArmorEnabled: true,
  }));
  const now = vi.fn(() => 1_785_620_000_000);
  let identity = 4;
  const next = vi.fn(() => {
    const value = identity;
    identity += 1;
    return {
      taskId: `${value}0000000-0000-4000-8000-00000000000${value}`,
      attemptId: `${value + 1}0000000-0000-4000-8000-00000000000${value + 1}`,
    };
  });
  return {
    processes: { run } satisfies ProcessExecutor,
    host: { inspect } satisfies HostReadinessInspector,
    clock: { now },
    probeIdentities: { next },
    calls: { inspect, next, now, run },
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    configuration: runnerConfiguration(),
    trustedImages: trustedImages(),
    ...dependencies(),
    ...overrides,
  };
}

function failure(candidate: unknown): unknown {
  try {
    new LocalRunnerOciPlatform(
      candidate as ConstructorParameters<typeof LocalRunnerOciPlatform>[0],
    );
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected OCI platform construction to fail.");
}

describe("local runner OCI platform composition", () => {
  it("parses local configuration before images and every dependency getter", () => {
    const reads: string[] = [];
    const candidate = Object.defineProperties(
      {},
      {
        configuration: {
          enumerable: true,
          get: () => {
            reads.push("configuration");
            return { secret: "invalid-local" };
          },
        },
        trustedImages: {
          enumerable: true,
          get: () => {
            reads.push("images");
            return trustedImages();
          },
        },
        processes: {
          enumerable: true,
          get: () => {
            reads.push("processes");
            return dependencies().processes;
          },
        },
      },
    );

    expect(failure(candidate)).toMatchObject({
      code: "invalid_configuration",
    });
    expect(reads).toEqual(["configuration"]);
  });

  it("parses trusted images before every dependency getter", () => {
    const reads: string[] = [];
    const candidate = Object.defineProperties(
      { configuration: runnerConfiguration() },
      {
        trustedImages: {
          enumerable: true,
          get: () => {
            reads.push("images");
            return { version: "1", images: [] };
          },
        },
        processes: {
          enumerable: true,
          get: () => {
            reads.push("processes");
            return dependencies().processes;
          },
        },
      },
    );

    expect(failure(candidate)).toMatchObject({ code: "invalid_images" });
    expect(reads).toEqual(["images"]);
  });

  it("constructs one frozen inert graph without invoking a capability", () => {
    const value = dependencies();
    const platform = new LocalRunnerOciPlatform({
      configuration: runnerConfiguration(),
      trustedImages: trustedImages(),
      ...value,
    });

    expect(Object.isFrozen(platform)).toBe(true);
    expect(Object.keys(platform)).toEqual([]);
    expect(value.calls.run).not.toHaveBeenCalled();
    expect(value.calls.inspect).not.toHaveBeenCalled();
    expect(value.calls.now).not.toHaveBeenCalled();
    expect(value.calls.next).not.toHaveBeenCalled();
  });

  it("derives the exact frozen probe resource profile", () => {
    const configuration = parseLocalRunnerConfiguration(runnerConfiguration());
    const profile = deriveLocalRunnerProbeProfile(configuration);

    expect(profile).toEqual({
      memoryBytes: configuration.execution.maximumMemoryBytes,
      cpuCount: 0.01,
      maximumPids: configuration.execution.maximumPids,
      workspaceBytes:
        configuration.execution.maximumWritableBytes -
        configuration.execution.temporaryBytes -
        configuration.execution.sharedMemoryBytes,
      temporaryBytes: configuration.execution.temporaryBytes,
      sharedMemoryBytes: configuration.execution.sharedMemoryBytes,
    });
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("derives one exact frozen OCI resource policy", () => {
    const configuration = parseLocalRunnerConfiguration(runnerConfiguration());
    const policy = deriveLocalRunnerOciPlatformPolicy(configuration);

    expect(policy).toEqual({
      deploymentId: configuration.identity.deploymentId,
      runnerId: configuration.identity.runnerId,
      executable: configuration.engine.executable,
      readinessTtlMs: configuration.engine.readinessTtlMs,
      controlTimeoutMs: configuration.engine.controlTimeoutMs,
      executionTimeoutMs: configuration.engine.executionTimeoutMs,
      maximumControlOutputBytes: configuration.engine.maximumControlOutputBytes,
      maximumExecutionOutputBytes:
        configuration.execution.maximumRuntimeOutputBytes,
      maximumFrameBytes: runtimeProtocolLimits.maximumFrameBytes,
      probeProfile: deriveLocalRunnerProbeProfile(configuration),
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.probeProfile)).toBe(true);
  });

  it("captures process methods and maps exact recovery control bounds", async () => {
    const requests: ProcessRequest[] = [];
    const run = vi.fn(async (request: ProcessRequest) => {
      requests.push(request);
      return processResult();
    });
    const value = dependencies(run);
    const platform = new LocalRunnerOciPlatform({
      configuration: runnerConfiguration(),
      trustedImages: trustedImages(),
      ...value,
    });
    value.processes.run = async () => {
      throw new Error("mutated process method");
    };

    await expect(platform.recoverOwned()).resolves.toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(requests[0]).toMatchObject({
      executable: "configured-nerdctl",
      timeoutMs: 12_345,
      maximumOutputBytes: 234_567,
    });
    expect(requests[0]?.arguments.slice(0, 3)).toEqual([
      "ps",
      "--all",
      "--quiet",
    ]);
  });

  it("maps exact inspector bounds before a failed image inspection", async () => {
    const requests: ProcessRequest[] = [];
    const run = vi.fn(async (request: ProcessRequest) => {
      requests.push(request);
      return processResult("not-json");
    });
    const value = dependencies(run);
    const platform = new LocalRunnerOciPlatform({
      configuration: runnerConfiguration(),
      trustedImages: trustedImages(),
      ...value,
    });

    await expect(platform.admit(imageDigest, "amd64")).rejects.toThrow();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        executable: "configured-nerdctl",
        timeoutMs: 12_345,
        maximumOutputBytes: 234_567,
      });
      expect(request.arguments).toContain("linux/amd64");
      expect(request.arguments.at(-1)).toBe(imageDigest);
    }
  });

  it("admits an image through one shared inspector, handshake, and backend graph", async () => {
    const requests: ProcessRequest[] = [];
    let activeName = "";
    let activeLabels: Record<string, string> = {};
    let starts = 0;
    const run = vi.fn(async (request: ProcessRequest) => {
      requests.push(request);
      const command = request.arguments[0];
      if (command === "image") {
        return request.arguments.includes("dockercompat")
          ? imageCompatibleInspection()
          : imageNativeInspection();
      }
      if (command === "version") {
        return processResult(
          JSON.stringify({
            Client: { Version: "2.3.1" },
            Server: { Version: "2.1.4" },
          }),
        );
      }
      if (command === "info") {
        return processResult(
          JSON.stringify({
            SecurityOptions: ["name=rootless", "name=seccomp"],
            Architecture: "amd64",
            CgroupVersion: "2",
          }),
        );
      }
      if (command === "create") {
        const nameIndex = request.arguments.indexOf("--name");
        activeName = request.arguments[nameIndex + 1] ?? "";
        activeLabels = {};
        for (let index = 0; index < request.arguments.length; index += 1) {
          if (request.arguments[index] !== "--label") continue;
          const label = request.arguments[index + 1] ?? "";
          const separator = label.indexOf("=");
          activeLabels[label.slice(0, separator)] = label.slice(separator + 1);
        }
        return processResult();
      }
      if (command === "inspect" && request.arguments.includes("--help")) {
        return processResult("--mode native");
      }
      if (command === "inspect" && request.arguments.includes("--mode")) {
        return processResult(fixtureNativeInspection());
      }
      if (command === "inspect") {
        return processResult(
          JSON.stringify({
            Name: activeName,
            Image: imageDigest,
            Config: { Image: imageDigest, Labels: activeLabels },
          }),
        );
      }
      if (command === "start") {
        starts += 1;
        if (starts === 1) {
          return processResult(
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
        return handshakeResult();
      }
      if (command === "rm") return processResult();
      throw new Error(`Unexpected platform command ${String(command)}.`);
    });
    const value = dependencies(run);
    const platform = new LocalRunnerOciPlatform({
      configuration: admissionRunnerConfiguration(),
      trustedImages: trustedImages(),
      ...value,
    });

    const admitted = await platform.admit(imageDigest, "amd64");
    expect(admitted).toMatchObject({
      digest: imageDigest,
      reference: imageDigest,
      architecture: "amd64",
    });
    expect(value.calls.inspect).toHaveBeenCalledOnce();
    expect(value.calls.next).toHaveBeenCalledTimes(2);
    expect(value.calls.now).toHaveBeenCalledTimes(4);
    expect(
      requests.filter((request) => request.arguments[0] === "image"),
    ).toHaveLength(2);
    expect(
      requests.filter((request) => request.arguments[0] === "create"),
    ).toHaveLength(2);
    expect(
      requests.filter((request) => request.arguments[0] === "start"),
    ).toHaveLength(2);
  });

  it("shares captured host, clock, and unique probe identities with the backend", async () => {
    const requests: ProcessRequest[] = [];
    const outcomes = [
      processResult(
        JSON.stringify({
          Client: { Version: "2.3.1" },
          Server: { Version: "2.1.4" },
        }),
      ),
      processResult(
        JSON.stringify({
          SecurityOptions: ["name=rootless", "name=seccomp"],
          Architecture: "amd64",
          CgroupVersion: "2",
        }),
      ),
      processResult("--mode native"),
      processResult("", { exitCode: 1, stderr: "expected create stop" }),
      processResult(
        JSON.stringify({
          Client: { Version: "2.3.1" },
          Server: { Version: "2.1.4" },
        }),
      ),
      processResult(
        JSON.stringify({
          SecurityOptions: ["name=rootless", "name=seccomp"],
          Architecture: "amd64",
          CgroupVersion: "2",
        }),
      ),
      processResult("--mode native"),
    ];
    const run = vi.fn(async (request: ProcessRequest) => {
      requests.push(request);
      const result = outcomes.shift();
      if (!result) throw new Error("unexpected process call");
      return result;
    });
    const value = dependencies(run);
    const fixedIdentity = {
      taskId: "40000000-0000-4000-8000-000000000004",
      attemptId: "50000000-0000-4000-8000-000000000005",
    };
    const fixedNext = vi.fn(() => fixedIdentity);
    value.probeIdentities.next = fixedNext;
    const platform = new LocalRunnerOciPlatform({
      configuration: runnerConfiguration(),
      trustedImages: trustedImages(),
      ...value,
    });
    value.host.inspect = async () => {
      throw new Error("mutated host method");
    };
    value.clock.now = () => {
      throw new Error("mutated clock method");
    };
    value.probeIdentities.next = () => {
      throw new Error("mutated identity method");
    };
    const image = createAdmittedImageForTesting(
      `runtime@${imageDigest}`,
      "amd64",
    );

    await expect(
      platform.executeRuntime({
        identity: fixtureIdentity,
        image,
        profile: fixtureProfile,
      }),
    ).rejects.toThrow();
    expect(value.calls.inspect).toHaveBeenCalledOnce();
    expect(value.calls.now).toHaveBeenCalledTimes(3);
    expect(fixedNext).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(4);
    for (const request of requests.slice(0, 3)) {
      expect(request).toMatchObject({
        executable: "configured-nerdctl",
        timeoutMs: 12_345,
        maximumOutputBytes: 234_567,
      });
    }
    const expectedProbe = createSandboxOwnership(
      runnerConfiguration().identity.deploymentId,
      {
        runnerId: fixtureIdentity.runnerId,
        ...fixedIdentity,
        fence: 1,
      },
    );
    expect(requests[3]?.arguments).toContain(expectedProbe.containerName);

    await expect(
      platform.executeRuntime({
        identity: fixtureIdentity,
        image,
        profile: fixtureProfile,
      }),
    ).rejects.toThrow("repeated an identity");
    expect(requests).toHaveLength(7);
    expect(fixedNext).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-finite", [Number.NaN]],
    ["negative", [-1]],
    ["regression", [1_000, 999]],
  ])(
    "rejects a %s epoch clock before issuing a probe identity",
    async (_name, times) => {
      const outcomes = [
        processResult(
          JSON.stringify({
            Client: { Version: "2.3.1" },
            Server: { Version: "2.1.4" },
          }),
        ),
        processResult(
          JSON.stringify({
            SecurityOptions: ["name=rootless", "name=seccomp"],
            Architecture: "amd64",
            CgroupVersion: "2",
          }),
        ),
        processResult("--mode native"),
      ];
      const run = vi.fn(async () => outcomes.shift() ?? processResult());
      const value = dependencies(run);
      let index = 0;
      value.clock.now = vi.fn(
        () => times[Math.min(index++, times.length - 1)]!,
      );
      const platform = new LocalRunnerOciPlatform({
        configuration: runnerConfiguration(),
        trustedImages: trustedImages(),
        ...value,
      });
      const image = createAdmittedImageForTesting(
        `runtime@${imageDigest}`,
        "amd64",
      );

      await expect(
        platform.executeRuntime({
          identity: fixtureIdentity,
          image,
          profile: fixtureProfile,
        }),
      ).rejects.toThrow("Epoch clock returned an invalid value");
      expect(value.calls.next).not.toHaveBeenCalled();
    },
  );

  it("publishes fixed frozen redacted construction failures", () => {
    const secret = "API_TOKEN=do-not-serialize";
    const error = failure(
      options({
        trustedImages: {
          ...trustedImages(),
          images: [{ ...trustedImages().images[0], environment: [secret] }],
        },
      }),
    );

    expect(error).toBeInstanceOf(LocalRunnerOciPlatformError);
    expect(error).toMatchObject({
      code: "invalid_images",
      message: "Local runner trusted image configuration is invalid.",
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([
    ["process", { processes: {} }],
    ["host", { host: { inspect: true } }],
    ["clock", { clock: {} }],
    ["identity", { probeIdentities: { next: null } }],
  ])("rejects an invalid %s dependency", (_name, override) => {
    expect(failure(options(override))).toMatchObject({
      code: "invalid_dependency",
      message: "Local runner OCI platform dependency is invalid.",
    });
  });

  it("normalizes a throwing dependency getter without revealing its value", () => {
    const secret = "private process capability";
    const candidate = Object.defineProperty(
      {
        ...options(),
      },
      "processes",
      {
        enumerable: true,
        get: () => {
          throw new Error(secret);
        },
      },
    );

    const error = failure(candidate);
    expect(error).toMatchObject({
      code: "invalid_dependency",
      message: "Local runner OCI platform dependency is invalid.",
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
