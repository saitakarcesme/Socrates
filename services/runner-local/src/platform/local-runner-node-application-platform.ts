import {
  parseLocalRunnerConfiguration,
  type LocalRunnerConfigurationV1,
} from "../configuration";
import { NodeDirectorySync } from "../durability";
import { nodeMonotonicTimeSource } from "../execution";
import {
  captureSandboxProbeIdentitySource,
  NodeHostReadinessInspector,
  NodeProcessExecutor,
} from "../oci";
import type {
  LocalAttemptDispatchLoopResult,
  LocalAttemptDispatchObserver,
} from "../session";
import { systemSpoolIdentitySource } from "../spool";
import { NodeLeaseAuthorityScheduler } from "../supervision";
import { systemWorkJournalIdentitySource } from "../work-journal";
import {
  LocalRunnerApplicationPlatform,
  LocalRunnerApplicationPlatformError,
} from "./local-runner-application-platform";

export type LocalRunnerNodeApplicationPlatformOptions = Readonly<{
  configuration: unknown;
  trustedImages: unknown;
  credential: unknown;
  fetch: typeof globalThis.fetch;
  observer: LocalAttemptDispatchObserver;
}>;

type LocalRunnerNodeApplicationPlatformErrorCode =
  | "adapter_composition_failed"
  | "composition_failed"
  | "invalid_capability"
  | "invalid_configuration"
  | "invalid_credential"
  | "invalid_images"
  | "invalid_input";

const errorMessages = Object.freeze({
  adapter_composition_failed: "Local runner Node adapter composition failed.",
  composition_failed: "Local runner Node platform composition failed.",
  invalid_capability: "Local runner Node platform capability is invalid.",
  invalid_configuration: "Local runner Node configuration is invalid.",
  invalid_credential: "Local runner Node credential is invalid.",
  invalid_images: "Local runner Node trusted images are invalid.",
  invalid_input: "Local runner Node platform input is invalid.",
} satisfies Record<LocalRunnerNodeApplicationPlatformErrorCode, string>);

export class LocalRunnerNodeApplicationPlatformError extends Error {
  constructor(readonly code: LocalRunnerNodeApplicationPlatformErrorCode) {
    super(errorMessages[code]);
    this.name = "LocalRunnerNodeApplicationPlatformError";
    Object.freeze(this);
  }
}

function configuration(
  options: LocalRunnerNodeApplicationPlatformOptions,
): LocalRunnerConfigurationV1 {
  try {
    const candidate = options.configuration;
    return parseLocalRunnerConfiguration(candidate);
  } catch {
    throw new LocalRunnerNodeApplicationPlatformError("invalid_configuration");
  }
}

function remainingInputs(options: LocalRunnerNodeApplicationPlatformOptions) {
  try {
    return Object.freeze({
      trustedImages: options.trustedImages,
      credential: options.credential,
      fetch: options.fetch,
      observer: options.observer,
    });
  } catch {
    throw new LocalRunnerNodeApplicationPlatformError("invalid_input");
  }
}

function nodeDependencies(configuration: LocalRunnerConfigurationV1) {
  try {
    const now = Date.now;
    return Object.freeze({
      processes: new NodeProcessExecutor(),
      host: new NodeHostReadinessInspector({
        configurationPath: configuration.engine.configurationPath,
        xdgRuntimeDirectory:
          configuration.engine.environment.xdgRuntimeDirectory,
        workingDirectory: configuration.engine.workingDirectory,
      }),
      clock: Object.freeze({ now: () => now() }),
      probeIdentities: captureSandboxProbeIdentitySource(),
      scheduler: new NodeLeaseAuthorityScheduler(),
      time: nodeMonotonicTimeSource,
      journalIdentity: systemWorkJournalIdentitySource,
      spoolIdentity: systemSpoolIdentitySource,
      directorySync: new NodeDirectorySync(),
    });
  } catch {
    throw new LocalRunnerNodeApplicationPlatformError(
      "adapter_composition_failed",
    );
  }
}

function applicationError(
  cause: unknown,
): LocalRunnerNodeApplicationPlatformError {
  if (cause instanceof LocalRunnerApplicationPlatformError) {
    if (cause.code === "invalid_images") {
      return new LocalRunnerNodeApplicationPlatformError("invalid_images");
    }
    if (cause.code === "invalid_credential") {
      return new LocalRunnerNodeApplicationPlatformError("invalid_credential");
    }
    if (cause.code === "invalid_dependency") {
      return new LocalRunnerNodeApplicationPlatformError("invalid_capability");
    }
  }
  return new LocalRunnerNodeApplicationPlatformError("composition_failed");
}

export class LocalRunnerNodeApplicationPlatform {
  readonly #run: (
    signal: AbortSignal,
  ) => Promise<LocalAttemptDispatchLoopResult>;

  constructor(options: LocalRunnerNodeApplicationPlatformOptions) {
    const admittedConfiguration = configuration(options);
    const inputs = remainingInputs(options);
    const dependencies = nodeDependencies(admittedConfiguration);
    try {
      const application = new LocalRunnerApplicationPlatform({
        configuration: admittedConfiguration,
        trustedImages: inputs.trustedImages,
        credential: inputs.credential,
        fetch: inputs.fetch,
        observer: inputs.observer,
        ...dependencies,
      });
      this.#run = application.run.bind(application);
      Object.freeze(this);
    } catch (cause) {
      throw applicationError(cause);
    }
  }

  run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    return this.#run(signal);
  }
}
