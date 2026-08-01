import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  ExecutionPlanProjector,
  type ExecutionImageAdmissionPort,
  type ExecutionSourceArtifactResolver,
  type ExecutionSourceMaterializerPort,
  type LocalExecutionPolicy,
  type MonotonicTimeSource,
  type SandboxOwnedResourceRecoveryPort,
  type SourceOwnedResourceRecoveryPort,
} from "../execution";
import type { RuntimeRequestMaterializerPort } from "../runtime";
import {
  RuntimeSandboxExecutor,
  type RuntimeSandboxExecutorOptions,
} from "../runtime";
import type { SpoolLimits } from "../spool/contracts";
import { spoolLimitsSchema } from "../spool/contracts";
import type { SpoolIdentitySource } from "../spool/store";
import type { DirectorySync } from "../durability/private-filesystem";
import type { LeaseAuthorityScheduler } from "../supervision/lease-authority-monitor";
import type { RunnerControlPlaneClient } from "../transport/client";
import type { WorkJournalLimits } from "../work-journal/contracts";
import { workJournalLimitsSchema } from "../work-journal/contracts";
import type { WorkJournalIdentitySource } from "../work-journal/store";
import type { FreshAttemptSandboxBackend } from "./fresh-attempt-session";

export interface LocalAttemptSandboxOwner
  extends SandboxOwnedResourceRecoveryPort, FreshAttemptSandboxBackend {}

export interface LocalAttemptSourceOwner
  extends SourceOwnedResourceRecoveryPort, ExecutionSourceMaterializerPort {}

export type LocalAttemptJournalConfiguration = Readonly<{
  rootPath: string;
  limits: WorkJournalLimits;
  identitySource: WorkJournalIdentitySource;
  directorySync?: DirectorySync;
}>;

export type LocalAttemptSpoolConfiguration = Readonly<{
  rootPath: string;
  limits: SpoolLimits;
  identitySource: SpoolIdentitySource;
  directorySync?: DirectorySync;
}>;

export type LocalAttemptOwnerOptions = Readonly<{
  sandbox: LocalAttemptSandboxOwner;
  sources: LocalAttemptSourceOwner;
  controlPlane: RunnerControlPlaneClient;
  scheduler: LeaseAuthorityScheduler;
  time: MonotonicTimeSource;
  artifacts: ExecutionSourceArtifactResolver;
  images: ExecutionImageAdmissionPort;
  requests: RuntimeRequestMaterializerPort;
  journal: LocalAttemptJournalConfiguration;
  spool: LocalAttemptSpoolConfiguration;
  executionPolicy: LocalExecutionPolicy;
  runtime: RuntimeSandboxExecutorOptions;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  revocationGracePeriodMs: number;
  maximumRecoveryAttempts: number;
}>;

export class LocalAttemptOwnerError extends Error {
  constructor(
    readonly code: "invalid_configuration" | "invalid_dependency",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalAttemptOwnerError";
    Object.freeze(this);
  }
}

export type CapturedOptions = Readonly<{
  sandbox: LocalAttemptSandboxOwner;
  sources: LocalAttemptSourceOwner;
  controlPlane: RunnerControlPlaneClient;
  scheduler: LeaseAuthorityScheduler;
  time: MonotonicTimeSource;
  artifacts: ExecutionSourceArtifactResolver;
  images: ExecutionImageAdmissionPort;
  requests: RuntimeRequestMaterializerPort;
  journal: LocalAttemptJournalConfiguration;
  spool: LocalAttemptSpoolConfiguration;
  executionPolicy: LocalExecutionPolicy;
  runtime: RuntimeSandboxExecutorOptions;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  revocationGracePeriodMs: number;
  maximumRecoveryAttempts: number;
}>;

function method<T extends object, K extends keyof T>(owner: T, name: K): T[K] {
  try {
    const candidate = owner[name];
    if (typeof candidate !== "function") {
      throw new TypeError(`${String(name)} must be a function.`);
    }
    return candidate.bind(owner) as T[K];
  } catch (cause) {
    throw new LocalAttemptOwnerError(
      "invalid_dependency",
      `Local attempt dependency method ${String(name)} is invalid.`,
      { cause },
    );
  }
}

function capturedSandbox(
  owner: LocalAttemptSandboxOwner,
): LocalAttemptSandboxOwner {
  return Object.freeze({
    recoverOwned: method(owner, "recoverOwned"),
    executeRuntime: method(owner, "executeRuntime"),
    cancel: method(owner, "cancel"),
  });
}

function capturedSources(
  owner: LocalAttemptSourceOwner,
): LocalAttemptSourceOwner {
  return Object.freeze({
    recoverOwned: method(owner, "recoverOwned"),
    materialize: method(owner, "materialize"),
    release: method(owner, "release"),
  });
}

function capturedControlPlane(
  owner: RunnerControlPlaneClient,
): RunnerControlPlaneClient {
  return Object.freeze({
    acquireTaskDelivery: method(owner, "acquireTaskDelivery"),
    claimTaskDelivery: method(owner, "claimTaskDelivery"),
    claimTask: method(owner, "claimTask"),
    reconcileAttempt: method(owner, "reconcileAttempt"),
    heartbeat: method(owner, "heartbeat"),
    submitEvent: method(owner, "submitEvent"),
  });
}

function capturedScheduler(
  owner: LeaseAuthorityScheduler,
): LeaseAuthorityScheduler {
  return Object.freeze({ wait: method(owner, "wait") });
}

function capturedTime(owner: MonotonicTimeSource): MonotonicTimeSource {
  return Object.freeze({ now: method(owner, "now") });
}

function capturedArtifacts(
  owner: ExecutionSourceArtifactResolver,
): ExecutionSourceArtifactResolver {
  return Object.freeze({ resolve: method(owner, "resolve") });
}

function capturedImages(
  owner: ExecutionImageAdmissionPort,
): ExecutionImageAdmissionPort {
  return Object.freeze({ admit: method(owner, "admit") });
}

function capturedRequests(
  owner: RuntimeRequestMaterializerPort,
): RuntimeRequestMaterializerPort {
  return Object.freeze({
    materialize: method(owner, "materialize"),
    release: method(owner, "release"),
  });
}

function capturedWorkIdentity(
  owner: WorkJournalIdentitySource,
): WorkJournalIdentitySource {
  return Object.freeze({
    attemptId: method(owner, "attemptId"),
    now: method(owner, "now"),
  });
}

function capturedSpoolIdentity(
  owner: SpoolIdentitySource,
): SpoolIdentitySource {
  return Object.freeze({
    eventId: method(owner, "eventId"),
    now: method(owner, "now"),
  });
}

function capturedDirectorySync(
  owner: DirectorySync | undefined,
): DirectorySync | undefined {
  return owner ? Object.freeze({ sync: method(owner, "sync") }) : undefined;
}

function nested(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" ||
    (candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate))
  );
}

function roots(
  journalRoot: string,
  spoolRoot: string,
): readonly [string, string] {
  try {
    if (!journalRoot.trim() || !spoolRoot.trim()) throw new TypeError("empty");
    const journal = resolve(journalRoot);
    const spool = resolve(spoolRoot);
    if (nested(journal, spool) || nested(spool, journal)) {
      throw new TypeError("overlap");
    }
    return Object.freeze([journal, spool]);
  } catch (cause) {
    throw new LocalAttemptOwnerError(
      "invalid_configuration",
      "Local attempt journal and spool roots must be distinct and non-overlapping.",
      { cause },
    );
  }
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LocalAttemptOwnerError(
      "invalid_configuration",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegative(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new LocalAttemptOwnerError(
      "invalid_configuration",
      `${name} must be a safe integer between 0 and ${maximum}.`,
    );
  }
  return value;
}

function snapshot(options: LocalAttemptOwnerOptions): CapturedOptions {
  try {
    const [journalRoot, spoolRoot] = roots(
      options.journal.rootPath,
      options.spool.rootPath,
    );
    const leaseDurationMs = positive(
      "leaseDurationMs",
      options.leaseDurationMs,
    );
    const heartbeatIntervalMs = positive(
      "heartbeatIntervalMs",
      options.heartbeatIntervalMs,
    );
    if (heartbeatIntervalMs > Math.floor(leaseDurationMs / 3)) {
      throw new LocalAttemptOwnerError(
        "invalid_configuration",
        "heartbeatIntervalMs must not exceed one third of leaseDurationMs.",
      );
    }
    const runtime = Object.freeze({
      maximumProtocolBytes: positive(
        "maximumProtocolBytes",
        options.runtime.maximumProtocolBytes,
      ),
      maximumChildOutputBytes: positive(
        "maximumChildOutputBytes",
        options.runtime.maximumChildOutputBytes,
      ),
    });
    const executionPolicy = Object.freeze({ ...options.executionPolicy });
    const sandbox = capturedSandbox(options.sandbox);
    const sources = capturedSources(options.sources);
    const requests = capturedRequests(options.requests);
    new ExecutionPlanProjector(executionPolicy);
    new RuntimeSandboxExecutor(sandbox, requests, runtime);

    return Object.freeze({
      sandbox,
      sources,
      controlPlane: capturedControlPlane(options.controlPlane),
      scheduler: capturedScheduler(options.scheduler),
      time: capturedTime(options.time),
      artifacts: capturedArtifacts(options.artifacts),
      images: capturedImages(options.images),
      requests,
      journal: Object.freeze({
        rootPath: journalRoot,
        limits: Object.freeze(
          workJournalLimitsSchema.parse(options.journal.limits),
        ),
        identitySource: capturedWorkIdentity(options.journal.identitySource),
        ...(options.journal.directorySync
          ? {
              directorySync: capturedDirectorySync(
                options.journal.directorySync,
              ),
            }
          : {}),
      }),
      spool: Object.freeze({
        rootPath: spoolRoot,
        limits: Object.freeze(spoolLimitsSchema.parse(options.spool.limits)),
        identitySource: capturedSpoolIdentity(options.spool.identitySource),
        ...(options.spool.directorySync
          ? {
              directorySync: capturedDirectorySync(options.spool.directorySync),
            }
          : {}),
      }),
      executionPolicy,
      runtime,
      leaseDurationMs,
      heartbeatIntervalMs,
      revocationGracePeriodMs: nonNegative(
        "revocationGracePeriodMs",
        options.revocationGracePeriodMs,
        60_000,
      ),
      maximumRecoveryAttempts: nonNegative(
        "maximumRecoveryAttempts",
        options.maximumRecoveryAttempts,
        100,
      ),
    });
  } catch (cause) {
    if (cause instanceof LocalAttemptOwnerError) throw cause;
    throw new LocalAttemptOwnerError(
      "invalid_configuration",
      "Local attempt owner configuration is invalid.",
      { cause },
    );
  }
}

export function captureLocalAttemptOwnerOptions(
  options: LocalAttemptOwnerOptions,
): CapturedOptions {
  return snapshot(options);
}
