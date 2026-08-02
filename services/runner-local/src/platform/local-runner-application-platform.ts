import { runnerBearerTokenSchema } from "@socrates/contracts";

import {
  parseLocalRunnerConfiguration,
  type LocalRunnerConfigurationV1,
} from "../configuration";
import type { DirectorySync } from "../durability";
import type { MonotonicTimeSource } from "../execution";
import {
  parseLocalRunnerTrustedImageCatalogConfiguration,
  type LocalRunnerTrustedImageCatalogConfigurationV1,
} from "../image";
import type {
  HostReadinessInspector,
  ProcessExecutor,
  ProcessRequest,
  ProcessResult,
  SandboxProbeIdentity,
  SandboxProbeIdentitySource,
} from "../oci";
import {
  LocalRunnerAuthenticatedAttemptLifecycle,
  type LocalAttemptDispatchLoopResult,
  type LocalAttemptDispatchObserver,
} from "../session";
import type { SpoolIdentitySource } from "../spool";
import type { LeaseAuthorityScheduler } from "../supervision";
import type { WorkJournalIdentitySource } from "../work-journal";
import {
  captureCapabilityFunction,
  captureCapabilityMethod,
} from "./capability-capture";
import {
  LocalRunnerOciPlatform,
  type LocalRunnerOciPlatformClock,
} from "./local-runner-oci-platform";

export type LocalRunnerApplicationPlatformOptions = Readonly<{
  configuration: unknown;
  trustedImages: unknown;
  credential: unknown;
  fetch: typeof globalThis.fetch;
  processes: ProcessExecutor;
  host: HostReadinessInspector;
  clock: LocalRunnerOciPlatformClock;
  probeIdentities: SandboxProbeIdentitySource;
  scheduler: LeaseAuthorityScheduler;
  time: MonotonicTimeSource;
  observer: LocalAttemptDispatchObserver;
  journalIdentity: WorkJournalIdentitySource;
  spoolIdentity: SpoolIdentitySource;
  directorySync: DirectorySync;
}>;

type LocalRunnerApplicationPlatformErrorCode =
  | "composition_failed"
  | "invalid_configuration"
  | "invalid_credential"
  | "invalid_dependency"
  | "invalid_images";

const errorMessages = Object.freeze({
  composition_failed: "Local runner application platform composition failed.",
  invalid_configuration: "Local runner application configuration is invalid.",
  invalid_credential: "Local runner application credential is invalid.",
  invalid_dependency: "Local runner application dependency is invalid.",
  invalid_images: "Local runner application trusted images are invalid.",
} satisfies Record<LocalRunnerApplicationPlatformErrorCode, string>);

export class LocalRunnerApplicationPlatformError extends Error {
  constructor(readonly code: LocalRunnerApplicationPlatformErrorCode) {
    super(errorMessages[code]);
    this.name = "LocalRunnerApplicationPlatformError";
    Object.freeze(this);
  }
}

function configuration(
  options: LocalRunnerApplicationPlatformOptions,
): LocalRunnerConfigurationV1 {
  try {
    return parseLocalRunnerConfiguration(options.configuration);
  } catch {
    throw new LocalRunnerApplicationPlatformError("invalid_configuration");
  }
}

function trustedImages(
  options: LocalRunnerApplicationPlatformOptions,
): LocalRunnerTrustedImageCatalogConfigurationV1 {
  try {
    return parseLocalRunnerTrustedImageCatalogConfiguration(
      options.trustedImages,
    );
  } catch {
    throw new LocalRunnerApplicationPlatformError("invalid_images");
  }
}

function credential(options: LocalRunnerApplicationPlatformOptions): string {
  try {
    const admitted = runnerBearerTokenSchema.safeParse(options.credential);
    if (!admitted.success) throw new TypeError("Credential is invalid.");
    return admitted.data;
  } catch {
    throw new LocalRunnerApplicationPlatformError("invalid_credential");
  }
}

function workIdentity(owner: WorkJournalIdentitySource) {
  return Object.freeze({
    attemptId: captureCapabilityMethod<
      [],
      ReturnType<WorkJournalIdentitySource["attemptId"]>
    >(owner, "attemptId"),
    now: captureCapabilityMethod<
      [],
      ReturnType<WorkJournalIdentitySource["now"]>
    >(owner, "now"),
  });
}

function spoolIdentity(owner: SpoolIdentitySource) {
  return Object.freeze({
    eventId: captureCapabilityMethod<
      [],
      ReturnType<SpoolIdentitySource["eventId"]>
    >(owner, "eventId"),
    now: captureCapabilityMethod<[], ReturnType<SpoolIdentitySource["now"]>>(
      owner,
      "now",
    ),
  });
}

function dependencies(options: LocalRunnerApplicationPlatformOptions) {
  try {
    return Object.freeze({
      fetch: captureCapabilityFunction<
        Parameters<typeof globalThis.fetch>,
        ReturnType<typeof globalThis.fetch>
      >(options.fetch),
      processes: Object.freeze({
        run: captureCapabilityMethod<[ProcessRequest], Promise<ProcessResult>>(
          options.processes,
          "run",
        ),
      }),
      host: Object.freeze({
        inspect: captureCapabilityMethod<
          [],
          ReturnType<HostReadinessInspector["inspect"]>
        >(options.host, "inspect"),
      }),
      clock: Object.freeze({
        now: captureCapabilityMethod<[], number>(options.clock, "now"),
      }),
      probeIdentities: Object.freeze({
        next: captureCapabilityMethod<[], SandboxProbeIdentity>(
          options.probeIdentities,
          "next",
        ),
      }),
      scheduler: Object.freeze({
        wait: captureCapabilityMethod<
          Parameters<LeaseAuthorityScheduler["wait"]>,
          ReturnType<LeaseAuthorityScheduler["wait"]>
        >(options.scheduler, "wait"),
      }),
      time: Object.freeze({
        now: captureCapabilityMethod<
          [],
          ReturnType<MonotonicTimeSource["now"]>
        >(options.time, "now"),
      }),
      observer: Object.freeze({
        observe: captureCapabilityMethod<
          Parameters<LocalAttemptDispatchObserver["observe"]>,
          ReturnType<LocalAttemptDispatchObserver["observe"]>
        >(options.observer, "observe"),
      }),
      journalIdentity: workIdentity(options.journalIdentity),
      spoolIdentity: spoolIdentity(options.spoolIdentity),
      directorySync: Object.freeze({
        sync: captureCapabilityMethod<
          Parameters<DirectorySync["sync"]>,
          ReturnType<DirectorySync["sync"]>
        >(options.directorySync, "sync"),
      }),
    });
  } catch {
    throw new LocalRunnerApplicationPlatformError("invalid_dependency");
  }
}

export class LocalRunnerApplicationPlatform {
  readonly #run: (
    signal: AbortSignal,
  ) => Promise<LocalAttemptDispatchLoopResult>;

  constructor(options: LocalRunnerApplicationPlatformOptions) {
    const admittedConfiguration = configuration(options);
    const admittedImages = trustedImages(options);
    const admittedCredential = credential(options);
    const admittedDependencies = dependencies(options);
    try {
      const oci = new LocalRunnerOciPlatform({
        configuration: admittedConfiguration,
        trustedImages: admittedImages,
        processes: admittedDependencies.processes,
        host: admittedDependencies.host,
        clock: admittedDependencies.clock,
        probeIdentities: admittedDependencies.probeIdentities,
      });
      const lifecycle = new LocalRunnerAuthenticatedAttemptLifecycle({
        configuration: admittedConfiguration,
        credential: admittedCredential,
        fetch: admittedDependencies.fetch,
        sandbox: oci,
        images: oci,
        scheduler: admittedDependencies.scheduler,
        time: admittedDependencies.time,
        observer: admittedDependencies.observer,
        journalIdentity: admittedDependencies.journalIdentity,
        spoolIdentity: admittedDependencies.spoolIdentity,
        directorySync: admittedDependencies.directorySync,
      });
      this.#run = lifecycle.run.bind(lifecycle);
      Object.freeze(this);
    } catch {
      throw new LocalRunnerApplicationPlatformError("composition_failed");
    }
  }

  run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    return this.#run(signal);
  }
}
