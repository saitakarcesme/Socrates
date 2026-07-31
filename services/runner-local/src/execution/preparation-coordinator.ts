import {
  isVerifiedArtifact,
  type VerifiedArtifact,
} from "@socrates/artifact-store";
import {
  runnerExecutionV1Schema,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import {
  assertAdmittedImage,
  type AdmittedSandboxImage,
} from "../image/capability";
import {
  sandboxAttemptKey,
  type SandboxAttemptIdentity,
} from "../oci/identity";
import {
  isMaterializedSourceSnapshot,
  type MaterializedSourceSnapshot,
} from "../source/capability";
import {
  ExecutionPlanProjector,
  type ProjectedExecutionPlan,
} from "./projector";

export interface ExecutionSourceArtifactResolver {
  resolve(input: {
    snapshotId: string;
    digest: string;
    signal?: AbortSignal;
  }): Promise<VerifiedArtifact | undefined>;
}

export interface ExecutionImageAdmissionPort {
  admit(
    manifestDigest: string,
    architecture: "amd64" | "arm64",
  ): Promise<AdmittedSandboxImage>;
}

export interface ExecutionSourceMaterializerPort {
  materialize(input: {
    artifact: VerifiedArtifact;
    identity: SandboxAttemptIdentity;
    signal?: AbortSignal;
  }): Promise<MaterializedSourceSnapshot>;
  release(capability: MaterializedSourceSnapshot): Promise<void>;
}

export type PreparedExecutionAttempt = Readonly<{
  identity: SandboxAttemptIdentity;
  plan: ProjectedExecutionPlan;
  image: AdmittedSandboxImage;
  source: MaterializedSourceSnapshot;
}>;

export class AttemptPreparationError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "cleanup_failed"
      | "invalid_artifact"
      | "invalid_image"
      | "invalid_prepared_attempt"
      | "invalid_source"
      | "release_failed"
      | "source_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttemptPreparationError";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cancellation(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AttemptPreparationError(
    "cancelled",
    "Attempt preparation was cancelled.",
    { cause: signal.reason },
  );
}

function identityFor(execution: RunnerExecutionV1): SandboxAttemptIdentity {
  return Object.freeze({
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
  });
}

export class AttemptPreparationCoordinator {
  readonly #execution: RunnerExecutionV1;
  readonly #identity: SandboxAttemptIdentity;
  readonly #projector: ExecutionPlanProjector;
  readonly #artifacts: ExecutionSourceArtifactResolver;
  readonly #images: ExecutionImageAdmissionPort;
  readonly #sources: ExecutionSourceMaterializerPort;
  #preparation: Promise<PreparedExecutionAttempt> | undefined;
  #prepared: PreparedExecutionAttempt | undefined;
  #release: Promise<void> | undefined;

  constructor(options: {
    execution: RunnerExecutionV1;
    projector: ExecutionPlanProjector;
    artifacts: ExecutionSourceArtifactResolver;
    images: ExecutionImageAdmissionPort;
    sources: ExecutionSourceMaterializerPort;
  }) {
    this.#execution = deepFreeze(
      runnerExecutionV1Schema.parse(options.execution),
    );
    this.#identity = identityFor(this.#execution);
    this.#projector = options.projector;
    this.#artifacts = options.artifacts;
    this.#images = options.images;
    this.#sources = options.sources;
  }

  prepare(signal?: AbortSignal): Promise<PreparedExecutionAttempt> {
    this.#preparation ??= this.#prepare(signal);
    return this.#preparation;
  }

  release(prepared: PreparedExecutionAttempt): Promise<void> {
    if (prepared !== this.#prepared) {
      return Promise.reject(
        new AttemptPreparationError(
          "invalid_prepared_attempt",
          "Prepared attempt is not owned by this coordinator.",
        ),
      );
    }
    this.#release ??= this.#sources
      .release(prepared.source)
      .catch((cause: unknown) => {
        throw new AttemptPreparationError(
          "release_failed",
          "Prepared source release failed.",
          { cause },
        );
      });
    return this.#release;
  }

  async #prepare(signal?: AbortSignal): Promise<PreparedExecutionAttempt> {
    const plan = this.#projector.project(this.#execution);
    cancellation(signal);

    let artifact: VerifiedArtifact | undefined;
    try {
      artifact = await this.#artifacts.resolve({
        snapshotId: this.#execution.task.source.snapshotId,
        digest: this.#execution.task.source.digest,
        signal,
      });
    } catch (cause) {
      cancellation(signal);
      throw cause;
    }
    cancellation(signal);
    if (!artifact) {
      throw new AttemptPreparationError(
        "source_unavailable",
        "The frozen source snapshot is unavailable.",
      );
    }
    if (
      !isVerifiedArtifact(artifact) ||
      artifact.digest !== this.#execution.task.source.digest
    ) {
      throw new AttemptPreparationError(
        "invalid_artifact",
        "Resolved source artifact does not match the frozen snapshot.",
      );
    }

    cancellation(signal);
    let image: AdmittedSandboxImage;
    try {
      image = await this.#images.admit(
        this.#execution.task.environment.imageDigest,
        this.#execution.task.environment.architecture,
      );
    } catch (cause) {
      cancellation(signal);
      throw cause;
    }
    cancellation(signal);
    try {
      assertAdmittedImage(image);
    } catch (cause) {
      throw new AttemptPreparationError(
        "invalid_image",
        "Image admission returned an invalid capability.",
        { cause },
      );
    }
    if (
      image.digest !== this.#execution.task.environment.imageDigest ||
      image.architecture !== this.#execution.task.environment.architecture
    ) {
      throw new AttemptPreparationError(
        "invalid_image",
        "Admitted image does not match the frozen environment.",
      );
    }

    let source: MaterializedSourceSnapshot | undefined;
    try {
      try {
        source = await this.#sources.materialize({
          artifact,
          identity: this.#identity,
          signal,
        });
      } catch (cause) {
        cancellation(signal);
        throw cause;
      }
      cancellation(signal);
      if (
        !isMaterializedSourceSnapshot(source) ||
        source.attemptKey !== sandboxAttemptKey(this.#identity) ||
        source.digest !== this.#execution.task.source.digest
      ) {
        throw new AttemptPreparationError(
          "invalid_source",
          "Materialized source does not match the frozen attempt.",
        );
      }
      const prepared = Object.freeze({
        identity: this.#identity,
        plan,
        image,
        source,
      });
      this.#prepared = prepared;
      return prepared;
    } catch (cause) {
      if (!source) throw cause;
      try {
        await this.#sources.release(source);
      } catch (cleanupCause) {
        throw new AttemptPreparationError(
          "cleanup_failed",
          "Attempt preparation failed and source cleanup is uncertain.",
          { cause: new AggregateError([cause, cleanupCause]) },
        );
      }
      throw cause;
    }
  }
}
