import { runtimeProtocolLimits } from "@socrates/runtime-protocol";

import {
  parseLocalRunnerConfiguration,
  type LocalRunnerConfigurationV1,
} from "../configuration";
import {
  NerdctlImageHandshakeVerifier,
  NerdctlImageInspector,
  parseLocalRunnerTrustedImageCatalogConfiguration,
  SandboxImageCatalog,
  type AdmittedSandboxImage,
} from "../image";
import {
  NerdctlReadinessVerifier,
  NerdctlSandboxBackend,
  NerdctlInvocation,
  type HostReadinessInspector,
  type ProcessExecutor,
  type ProcessRequest,
  type ProcessResult,
  type SandboxAttemptIdentity,
  type SandboxExecutionResult,
  type SandboxProbeIdentity,
  type SandboxProbeIdentitySource,
  type SandboxResourceProfile,
  type SandboxRuntimeExecution,
  type SandboxTerminationReceipt,
} from "../oci";
import { validateSandboxProfile } from "../oci/profile";
import { captureSandboxProbeIdentitySource } from "../oci/probe-identity";
import { captureCapabilityMethod } from "./capability-capture";

export interface LocalRunnerOciPlatformClock {
  now(): number;
}

export type LocalRunnerOciPlatformOptions = Readonly<{
  configuration: unknown;
  trustedImages: unknown;
  processes: ProcessExecutor;
  host: HostReadinessInspector;
  clock: LocalRunnerOciPlatformClock;
  probeIdentities: SandboxProbeIdentitySource;
}>;

type LocalRunnerOciPlatformErrorCode =
  | "composition_failed"
  | "invalid_configuration"
  | "invalid_dependency"
  | "invalid_images";

const errorMessages = Object.freeze({
  composition_failed: "Local runner OCI platform composition failed.",
  invalid_configuration: "Local runner OCI configuration is invalid.",
  invalid_dependency: "Local runner OCI platform dependency is invalid.",
  invalid_images: "Local runner trusted image configuration is invalid.",
} satisfies Record<LocalRunnerOciPlatformErrorCode, string>);

export class LocalRunnerOciPlatformError extends Error {
  constructor(
    readonly code: LocalRunnerOciPlatformErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "LocalRunnerOciPlatformError";
    Object.freeze(this);
  }
}

function configuration(options: LocalRunnerOciPlatformOptions) {
  try {
    return parseLocalRunnerConfiguration(options.configuration);
  } catch (cause) {
    throw new LocalRunnerOciPlatformError("invalid_configuration", { cause });
  }
}

function trustedImages(options: LocalRunnerOciPlatformOptions) {
  try {
    return parseLocalRunnerTrustedImageCatalogConfiguration(
      options.trustedImages,
    );
  } catch (cause) {
    throw new LocalRunnerOciPlatformError("invalid_images", { cause });
  }
}

function dependencies(options: LocalRunnerOciPlatformOptions) {
  try {
    const run = captureCapabilityMethod<
      [ProcessRequest],
      Promise<ProcessResult>
    >(options.processes, "run");
    const inspect = captureCapabilityMethod<
      [],
      ReturnType<HostReadinessInspector["inspect"]>
    >(options.host, "inspect");
    const rawNow = captureCapabilityMethod<[], number>(options.clock, "now");
    const rawNext = captureCapabilityMethod<[], SandboxProbeIdentity>(
      options.probeIdentities,
      "next",
    );
    let previousTime = -1;
    const clock = Object.freeze({
      now: () => {
        const value = rawNow();
        if (
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > 8_640_000_000_000_000 ||
          value < previousTime
        ) {
          throw new TypeError("Epoch clock returned an invalid value.");
        }
        previousTime = value;
        return value;
      },
    });
    const capturedIdentities = captureSandboxProbeIdentitySource({
      next: rawNext,
    });
    const issuedIdentities = new Set<string>();
    const probeIdentities = Object.freeze({
      next: () => {
        const value = capturedIdentities.next();
        const key = `${value.taskId}/${value.attemptId}`;
        if (issuedIdentities.has(key)) {
          throw new TypeError("Probe identity source repeated an identity.");
        }
        issuedIdentities.add(key);
        return value;
      },
    });
    return Object.freeze({
      processes: Object.freeze({ run }),
      host: Object.freeze({ inspect }),
      clock,
      probeIdentities,
    });
  } catch (cause) {
    throw new LocalRunnerOciPlatformError("invalid_dependency", { cause });
  }
}

export function deriveLocalRunnerProbeProfile(
  admitted: LocalRunnerConfigurationV1,
): SandboxResourceProfile {
  const execution = admitted.execution;
  const profile = Object.freeze({
    memoryBytes: execution.maximumMemoryBytes,
    cpuCount: execution.minimumCpuQuotaMicros / execution.cpuQuotaPeriodMicros,
    maximumPids: execution.maximumPids,
    workspaceBytes:
      execution.maximumWritableBytes -
      execution.temporaryBytes -
      execution.sharedMemoryBytes,
    temporaryBytes: execution.temporaryBytes,
    sharedMemoryBytes: execution.sharedMemoryBytes,
  });
  validateSandboxProfile(profile);
  return profile;
}

export function deriveLocalRunnerOciPlatformPolicy(
  admitted: LocalRunnerConfigurationV1,
) {
  return Object.freeze({
    deploymentId: admitted.identity.deploymentId,
    runnerId: admitted.identity.runnerId,
    invocation: Object.freeze({
      executable: admitted.engine.executable,
      address: admitted.engine.address,
      namespace: `socrates-${admitted.identity.deploymentId}`,
      snapshotter: admitted.engine.snapshotter,
      dataRoot: admitted.engine.dataRoot,
      configurationPath: admitted.engine.configurationPath,
      workingDirectory: admitted.engine.workingDirectory,
      environment: admitted.engine.environment,
    }),
    readinessTtlMs: admitted.engine.readinessTtlMs,
    controlTimeoutMs: admitted.engine.controlTimeoutMs,
    executionTimeoutMs: admitted.engine.executionTimeoutMs,
    maximumControlOutputBytes: admitted.engine.maximumControlOutputBytes,
    maximumExecutionOutputBytes: admitted.execution.maximumRuntimeOutputBytes,
    maximumFrameBytes: runtimeProtocolLimits.maximumFrameBytes,
    probeProfile: deriveLocalRunnerProbeProfile(admitted),
  });
}

export class LocalRunnerOciPlatform {
  readonly #admit: (
    manifestDigest: string,
    architecture: "amd64" | "arm64",
  ) => Promise<AdmittedSandboxImage>;
  readonly #recoverOwned: () => Promise<number>;
  readonly #cancel: (
    identity: SandboxAttemptIdentity,
    gracePeriodMs: number,
  ) => Promise<SandboxTerminationReceipt>;
  readonly #executeRuntime: (
    input: SandboxRuntimeExecution,
  ) => Promise<SandboxExecutionResult>;

  constructor(options: LocalRunnerOciPlatformOptions) {
    const admittedConfiguration = configuration(options);
    const admittedImages = trustedImages(options);
    const admittedDependencies = dependencies(options);
    try {
      const policy = deriveLocalRunnerOciPlatformPolicy(admittedConfiguration);
      const invocation = new NerdctlInvocation(policy.invocation);
      const readiness = new NerdctlReadinessVerifier(
        admittedDependencies.processes,
        admittedDependencies.host,
        invocation,
        {
          timeoutMs: policy.controlTimeoutMs,
          maximumOutputBytes: policy.maximumControlOutputBytes,
          now: () => new Date(admittedDependencies.clock.now()),
          configurationPath: policy.invocation.configurationPath,
          xdgRuntimeDirectory:
            policy.invocation.environment.xdgRuntimeDirectory,
          workingDirectory: policy.invocation.workingDirectory,
        },
      );
      const backend = new NerdctlSandboxBackend(
        admittedDependencies.processes,
        readiness,
        invocation,
        {
          deploymentId: policy.deploymentId,
          runnerId: policy.runnerId,
          readinessTtlMs: policy.readinessTtlMs,
          controlTimeoutMs: policy.controlTimeoutMs,
          executionTimeoutMs: policy.executionTimeoutMs,
          maximumControlOutputBytes: policy.maximumControlOutputBytes,
          maximumExecutionOutputBytes: policy.maximumExecutionOutputBytes,
          now: admittedDependencies.clock.now,
          probeIdentitySource: admittedDependencies.probeIdentities,
        },
      );
      const inspector = new NerdctlImageInspector(
        admittedDependencies.processes,
        invocation,
        {
          timeoutMs: policy.controlTimeoutMs,
          maximumOutputBytes: policy.maximumControlOutputBytes,
        },
      );
      const handshake = new NerdctlImageHandshakeVerifier(backend, {
        runnerId: policy.runnerId,
        profile: policy.probeProfile,
        maximumFrameBytes: policy.maximumFrameBytes,
        probeIdentitySource: admittedDependencies.probeIdentities,
      });
      const catalog = new SandboxImageCatalog(
        admittedImages.images,
        inspector,
        handshake,
      );
      this.#admit = catalog.admit.bind(catalog);
      this.#recoverOwned = backend.recoverOwned.bind(backend);
      this.#cancel = backend.cancel.bind(backend);
      this.#executeRuntime = backend.executeRuntime.bind(backend);
      Object.freeze(this);
    } catch (cause) {
      throw new LocalRunnerOciPlatformError("composition_failed", { cause });
    }
  }

  admit(
    manifestDigest: string,
    architecture: "amd64" | "arm64",
  ): Promise<AdmittedSandboxImage> {
    return this.#admit(manifestDigest, architecture);
  }

  recoverOwned(): Promise<number> {
    return this.#recoverOwned();
  }

  cancel(
    identity: SandboxAttemptIdentity,
    gracePeriodMs: number,
  ): Promise<SandboxTerminationReceipt> {
    return this.#cancel(identity, gracePeriodMs);
  }

  executeRuntime(
    input: SandboxRuntimeExecution,
  ): Promise<SandboxExecutionResult> {
    return this.#executeRuntime(input);
  }
}
