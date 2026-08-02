import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";

import { parseLocalRunnerConfiguration } from "../configuration";
import type { DirectorySync } from "../durability";
import type {
  ExecutionImageAdmissionPort,
  MonotonicTimeSource,
} from "../execution";
import { RuntimeRequestMaterializer } from "../request";
import {
  BoundedSourceArtifactResolverFactory,
  SourceSnapshotMaterializer,
  type RunnerSourceSnapshotTransport,
} from "../source";
import type { SpoolIdentitySource } from "../spool";
import type { LeaseAuthorityScheduler } from "../supervision";
import type { RunnerControlPlaneClient } from "../transport";
import type { WorkJournalIdentitySource } from "../work-journal";
import {
  LocalAttemptDispatchLoop,
  type LocalAttemptDispatchLoopResult,
  type LocalAttemptDispatchObserver,
} from "./local-attempt-dispatch-loop";
import {
  LocalAttemptOwner,
  type LocalAttemptSandboxOwner,
} from "./local-attempt-owner";

export type LocalRunnerAttemptControlPlane = RunnerControlPlaneClient &
  RunnerSourceSnapshotTransport;

export type LocalRunnerAttemptLifecycleOptions = Readonly<{
  configuration: unknown;
  controlPlane: LocalRunnerAttemptControlPlane;
  sandbox: LocalAttemptSandboxOwner;
  images: ExecutionImageAdmissionPort;
  scheduler: LeaseAuthorityScheduler;
  time: MonotonicTimeSource;
  observer: LocalAttemptDispatchObserver;
  journalIdentity: WorkJournalIdentitySource;
  spoolIdentity: SpoolIdentitySource;
  directorySync: DirectorySync;
}>;

type LocalRunnerAttemptLifecycleErrorCode =
  "composition_failed" | "invalid_configuration" | "invalid_dependency";

const errorMessages = Object.freeze({
  composition_failed: "Local runner attempt lifecycle composition failed.",
  invalid_configuration: "Local runner attempt configuration is invalid.",
  invalid_dependency: "Local runner attempt dependency is invalid.",
} satisfies Record<LocalRunnerAttemptLifecycleErrorCode, string>);

export class LocalRunnerAttemptLifecycleError extends Error {
  constructor(
    readonly code: LocalRunnerAttemptLifecycleErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "LocalRunnerAttemptLifecycleError";
    Object.freeze(this);
  }
}

function method<T extends object, K extends keyof T>(owner: T, name: K): T[K] {
  try {
    const candidate = owner[name];
    if (typeof candidate !== "function") throw new TypeError("Not a function.");
    return candidate.bind(owner) as T[K];
  } catch (cause) {
    throw new LocalRunnerAttemptLifecycleError("invalid_dependency", {
      cause,
    });
  }
}

function captureDependencies(options: LocalRunnerAttemptLifecycleOptions) {
  try {
    const controlPlaneOwner = options.controlPlane;
    const sandboxOwner = options.sandbox;
    const imageOwner = options.images;
    const schedulerOwner = options.scheduler;
    const timeOwner = options.time;
    const observerOwner = options.observer;
    const journalIdentityOwner = options.journalIdentity;
    const spoolIdentityOwner = options.spoolIdentity;
    const directorySyncOwner = options.directorySync;
    const controlPlane = Object.freeze({
      acquireTaskDelivery: method(controlPlaneOwner, "acquireTaskDelivery"),
      claimTaskDelivery: method(controlPlaneOwner, "claimTaskDelivery"),
      claimTask: method(controlPlaneOwner, "claimTask"),
      reconcileAttempt: method(controlPlaneOwner, "reconcileAttempt"),
      heartbeat: method(controlPlaneOwner, "heartbeat"),
      submitEvent: method(controlPlaneOwner, "submitEvent"),
      open: method(controlPlaneOwner, "open"),
    });
    const sandbox = Object.freeze({
      recoverOwned: method(sandboxOwner, "recoverOwned"),
      cancel: method(sandboxOwner, "cancel"),
      executeRuntime: method(sandboxOwner, "executeRuntime"),
    });
    const images = Object.freeze({ admit: method(imageOwner, "admit") });
    const scheduler = Object.freeze({
      wait: method(schedulerOwner, "wait"),
    });
    const time = Object.freeze({ now: method(timeOwner, "now") });
    const observer = Object.freeze({
      observe: method(observerOwner, "observe"),
    });
    const journalIdentity = Object.freeze({
      attemptId: method(journalIdentityOwner, "attemptId"),
      now: method(journalIdentityOwner, "now"),
    });
    const spoolIdentity = Object.freeze({
      eventId: method(spoolIdentityOwner, "eventId"),
      now: method(spoolIdentityOwner, "now"),
    });
    const directorySync = Object.freeze({
      sync: method(directorySyncOwner, "sync"),
    });
    return Object.freeze({
      controlPlane,
      sandbox,
      images,
      scheduler,
      time,
      observer,
      journalIdentity,
      spoolIdentity,
      directorySync,
    });
  } catch (cause) {
    if (cause instanceof LocalRunnerAttemptLifecycleError) throw cause;
    throw new LocalRunnerAttemptLifecycleError("invalid_dependency", {
      cause,
    });
  }
}

export class LocalRunnerAttemptLifecycle {
  readonly #run: (
    signal: AbortSignal,
  ) => Promise<LocalAttemptDispatchLoopResult>;

  constructor(options: LocalRunnerAttemptLifecycleOptions) {
    let configuration;
    try {
      configuration = parseLocalRunnerConfiguration(options.configuration);
    } catch (cause) {
      throw new LocalRunnerAttemptLifecycleError("invalid_configuration", {
        cause,
      });
    }
    const dependencies = captureDependencies(options);
    try {
      const artifacts = new LocalContentAddressedArtifactStore(
        configuration.roots.artifacts,
      );
      const sources = new SourceSnapshotMaterializer(artifacts, {
        root: configuration.roots.sources,
        deploymentId: configuration.identity.deploymentId,
        runnerId: configuration.identity.runnerId,
        limits: configuration.source,
      });
      const requests = new RuntimeRequestMaterializer({
        deploymentId: configuration.identity.deploymentId,
        runnerId: configuration.identity.runnerId,
        maximumBytes: configuration.request.maximumBytes,
      });
      const artifactResolvers = new BoundedSourceArtifactResolverFactory({
        maximumArchiveBytes: configuration.source.maximumArchiveBytes,
        transport: dependencies.controlPlane,
        artifacts,
      });
      const owner = new LocalAttemptOwner({
        sandbox: dependencies.sandbox,
        sources,
        controlPlane: dependencies.controlPlane,
        scheduler: dependencies.scheduler,
        time: dependencies.time,
        artifactResolvers,
        images: dependencies.images,
        requests,
        journal: {
          rootPath: configuration.roots.journal,
          limits: configuration.durability.journal,
          identitySource: dependencies.journalIdentity,
          directorySync: dependencies.directorySync,
        },
        spool: {
          rootPath: configuration.roots.spool,
          limits: configuration.durability.spool,
          identitySource: dependencies.spoolIdentity,
          directorySync: dependencies.directorySync,
        },
        executionPolicy: configuration.execution,
        runtime: configuration.runtime,
        leaseDurationMs: configuration.lifecycle.leaseDurationMs,
        heartbeatIntervalMs: configuration.lifecycle.heartbeatIntervalMs,
        revocationGracePeriodMs:
          configuration.lifecycle.revocationGracePeriodMs,
        maximumRecoveryAttempts:
          configuration.lifecycle.maximumRecoveryAttempts,
      });
      const loop = new LocalAttemptDispatchLoop({
        owner,
        delay: dependencies.scheduler,
        observer: dependencies.observer,
        pollIntervalMs: configuration.lifecycle.pollIntervalMs,
      });
      this.#run = loop.run.bind(loop);
      Object.freeze(this);
    } catch (cause) {
      if (cause instanceof LocalRunnerAttemptLifecycleError) throw cause;
      throw new LocalRunnerAttemptLifecycleError("composition_failed", {
        cause,
      });
    }
  }

  run(signal: AbortSignal): Promise<LocalAttemptDispatchLoopResult> {
    return this.#run(signal);
  }
}
