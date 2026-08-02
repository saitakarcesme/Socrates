import { runnerBearerTokenSchema } from "@socrates/contracts";

import { parseLocalRunnerConfiguration } from "../configuration";
import { RunnerHttpClient } from "../transport";
import {
  LocalRunnerAttemptLifecycle,
  LocalRunnerAttemptLifecycleError,
  type LocalRunnerAttemptLifecycleOptions,
} from "./local-runner-attempt-lifecycle";
import type { LocalAttemptDispatchLoopResult } from "./local-attempt-dispatch-loop";

type InjectedAttemptCapabilities = Omit<
  LocalRunnerAttemptLifecycleOptions,
  "configuration" | "controlPlane"
>;

export type LocalRunnerAuthenticatedAttemptLifecycleOptions =
  InjectedAttemptCapabilities &
    Readonly<{
      configuration: unknown;
      credential: unknown;
      fetch: typeof globalThis.fetch;
    }>;

type LocalRunnerAuthenticatedAttemptLifecycleErrorCode =
  | "composition_failed"
  | "invalid_configuration"
  | "invalid_credential"
  | "invalid_dependency";

const errorMessages = Object.freeze({
  composition_failed:
    "Authenticated local runner attempt lifecycle composition failed.",
  invalid_configuration:
    "Authenticated local runner attempt configuration is invalid.",
  invalid_credential: "Authenticated local runner credential is invalid.",
  invalid_dependency: "Authenticated local runner dependency is invalid.",
} satisfies Record<LocalRunnerAuthenticatedAttemptLifecycleErrorCode, string>);

export class LocalRunnerAuthenticatedAttemptLifecycleError extends Error {
  constructor(
    readonly code: LocalRunnerAuthenticatedAttemptLifecycleErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "LocalRunnerAuthenticatedAttemptLifecycleError";
    Object.freeze(this);
  }
}

function configuration(
  options: LocalRunnerAuthenticatedAttemptLifecycleOptions,
) {
  try {
    return parseLocalRunnerConfiguration(options.configuration);
  } catch (cause) {
    throw new LocalRunnerAuthenticatedAttemptLifecycleError(
      "invalid_configuration",
      { cause },
    );
  }
}

function credential(
  options: LocalRunnerAuthenticatedAttemptLifecycleOptions,
): string {
  try {
    const parsed = runnerBearerTokenSchema.safeParse(options.credential);
    if (!parsed.success) throw new TypeError("Invalid credential.");
    return parsed.data;
  } catch (cause) {
    throw new LocalRunnerAuthenticatedAttemptLifecycleError(
      "invalid_credential",
      { cause },
    );
  }
}

function dependencies(
  options: LocalRunnerAuthenticatedAttemptLifecycleOptions,
) {
  try {
    const fetchCandidate = options.fetch;
    if (typeof fetchCandidate !== "function") {
      throw new TypeError("Fetch capability is not callable.");
    }
    const fetch = Reflect.apply(Function.prototype.bind, fetchCandidate, [
      undefined,
    ]) as typeof globalThis.fetch;
    return Object.freeze({
      fetch,
      sandbox: options.sandbox,
      images: options.images,
      scheduler: options.scheduler,
      time: options.time,
      observer: options.observer,
      journalIdentity: options.journalIdentity,
      spoolIdentity: options.spoolIdentity,
      directorySync: options.directorySync,
    });
  } catch (cause) {
    throw new LocalRunnerAuthenticatedAttemptLifecycleError(
      "invalid_dependency",
      { cause },
    );
  }
}

export class LocalRunnerAuthenticatedAttemptLifecycle {
  readonly #run: (
    signal: AbortSignal,
  ) => Promise<LocalAttemptDispatchLoopResult>;

  constructor(options: LocalRunnerAuthenticatedAttemptLifecycleOptions) {
    const admittedConfiguration = configuration(options);
    const admittedCredential = credential(options);
    const admittedDependencies = dependencies(options);
    try {
      const controlPlane = new RunnerHttpClient({
        baseUrl: admittedConfiguration.controlPlane.origin,
        credential: admittedCredential,
        timeoutMs: admittedConfiguration.controlPlane.timeoutMs,
        maximumResponseBytes:
          admittedConfiguration.controlPlane.maximumResponseBytes,
        maximumSourceBytes: admittedConfiguration.source.maximumArchiveBytes,
        fetch: admittedDependencies.fetch,
      });
      const lifecycle = new LocalRunnerAttemptLifecycle({
        configuration: admittedConfiguration,
        controlPlane,
        sandbox: admittedDependencies.sandbox,
        images: admittedDependencies.images,
        scheduler: admittedDependencies.scheduler,
        time: admittedDependencies.time,
        observer: admittedDependencies.observer,
        journalIdentity: admittedDependencies.journalIdentity,
        spoolIdentity: admittedDependencies.spoolIdentity,
        directorySync: admittedDependencies.directorySync,
      });
      this.#run = lifecycle.run.bind(lifecycle);
      Object.freeze(this);
    } catch (cause) {
      if (
        cause instanceof LocalRunnerAttemptLifecycleError &&
        cause.code === "invalid_dependency"
      ) {
        throw new LocalRunnerAuthenticatedAttemptLifecycleError(
          "invalid_dependency",
          { cause },
        );
      }
      throw new LocalRunnerAuthenticatedAttemptLifecycleError(
        "composition_failed",
        { cause },
      );
    }
  }

  run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    return this.#run(signal);
  }
}
