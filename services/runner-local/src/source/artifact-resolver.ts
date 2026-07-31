import {
  isVerifiedArtifact,
  type ArtifactStore,
  type VerifiedArtifact,
} from "@socrates/artifact-store";

import {
  sandboxAttemptKey,
  type SandboxAttemptIdentity,
} from "../oci/identity";
import { sourceSnapshotMediaType } from "./materializer";

export type SourceSnapshotStream = Readonly<{
  mediaType: string;
  sizeBytes: number;
  content: AsyncIterable<Uint8Array>;
}>;

export interface RunnerSourceSnapshotTransport {
  open(input: {
    identity: SandboxAttemptIdentity;
    snapshotId: string;
    digest: string;
    signal?: AbortSignal;
  }): Promise<SourceSnapshotStream | undefined>;
}

export type ResolveSourceArtifactInput = Readonly<{
  snapshotId: string;
  digest: string;
  signal?: AbortSignal;
}>;

export class BoundedSourceArtifactResolverError extends Error {
  constructor(
    readonly code:
      | "authority_conflict"
      | "cancelled"
      | "invalid_artifact"
      | "invalid_configuration"
      | "invalid_descriptor"
      | "source_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoundedSourceArtifactResolverError";
  }
}

const identifierPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function cancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new BoundedSourceArtifactResolverError(
    "cancelled",
    "Source artifact resolution was cancelled.",
    { cause: signal.reason },
  );
}

function validReference(input: ResolveSourceArtifactInput): void {
  if (
    !identifierPattern.test(input.snapshotId) ||
    !digestPattern.test(input.digest)
  ) {
    throw new BoundedSourceArtifactResolverError(
      "invalid_descriptor",
      "Source snapshot identity is invalid.",
    );
  }
}

export class BoundedSourceArtifactResolver {
  readonly #identity: SandboxAttemptIdentity;
  readonly #maximumArchiveBytes: number;
  readonly #transport: RunnerSourceSnapshotTransport;
  readonly #artifacts: ArtifactStore;
  #authority: ResolveSourceArtifactInput | undefined;
  #resolution: Promise<VerifiedArtifact> | undefined;

  constructor(options: {
    identity: SandboxAttemptIdentity;
    maximumArchiveBytes: number;
    transport: RunnerSourceSnapshotTransport;
    artifacts: ArtifactStore;
  }) {
    try {
      sandboxAttemptKey(options.identity);
    } catch (cause) {
      throw new BoundedSourceArtifactResolverError(
        "invalid_configuration",
        "Source resolver attempt identity is invalid.",
        { cause },
      );
    }
    if (
      !Number.isSafeInteger(options.maximumArchiveBytes) ||
      options.maximumArchiveBytes < 1
    ) {
      throw new BoundedSourceArtifactResolverError(
        "invalid_configuration",
        "Source resolver maximum must be a positive safe integer.",
      );
    }
    this.#identity = Object.freeze({ ...options.identity });
    this.#maximumArchiveBytes = options.maximumArchiveBytes;
    this.#transport = options.transport;
    this.#artifacts = options.artifacts;
  }

  resolve(input: ResolveSourceArtifactInput): Promise<VerifiedArtifact> {
    if (this.#authority) {
      if (
        input.snapshotId !== this.#authority.snapshotId ||
        input.digest !== this.#authority.digest ||
        input.signal !== this.#authority.signal
      ) {
        return Promise.reject(
          new BoundedSourceArtifactResolverError(
            "authority_conflict",
            "Source resolution authority cannot be replaced.",
          ),
        );
      }
      return this.#resolution!;
    }

    this.#authority = Object.freeze({ ...input });
    this.#resolution = this.#resolve(this.#authority);
    return this.#resolution;
  }

  async #resolve(input: ResolveSourceArtifactInput): Promise<VerifiedArtifact> {
    validReference(input);
    cancelled(input.signal);

    let descriptor: SourceSnapshotStream | undefined;
    try {
      descriptor = await this.#transport.open({
        identity: this.#identity,
        snapshotId: input.snapshotId,
        digest: input.digest,
        signal: input.signal,
      });
    } catch (cause) {
      cancelled(input.signal);
      throw cause;
    }
    cancelled(input.signal);
    if (!descriptor) {
      throw new BoundedSourceArtifactResolverError(
        "source_unavailable",
        "The exact source snapshot is unavailable.",
      );
    }
    if (
      descriptor.mediaType !== sourceSnapshotMediaType ||
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      descriptor.sizeBytes < 1 ||
      descriptor.sizeBytes > this.#maximumArchiveBytes ||
      !descriptor.content ||
      typeof descriptor.content[Symbol.asyncIterator] !== "function"
    ) {
      throw new BoundedSourceArtifactResolverError(
        "invalid_descriptor",
        "Source transport returned an invalid bounded descriptor.",
      );
    }

    const signal = input.signal;
    const content = descriptor.content;
    const cancellationAware = async function* () {
      for await (const chunk of content) {
        cancelled(signal);
        yield chunk;
      }
      cancelled(signal);
    };

    let artifact: VerifiedArtifact;
    try {
      artifact = await this.#artifacts.put({
        content: cancellationAware(),
        expectedDigest: input.digest,
        expectedSizeBytes: descriptor.sizeBytes,
        maxSizeBytes: this.#maximumArchiveBytes,
      });
    } catch (cause) {
      cancelled(input.signal);
      throw cause;
    }
    cancelled(input.signal);
    if (
      !isVerifiedArtifact(artifact) ||
      artifact.digest !== input.digest ||
      artifact.sizeBytes !== descriptor.sizeBytes
    ) {
      throw new BoundedSourceArtifactResolverError(
        "invalid_artifact",
        "Artifact store returned an invalid source capability.",
      );
    }
    return artifact;
  }
}
