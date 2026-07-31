import type { VerifiedArtifact } from "./verification";

export type { VerifiedArtifact } from "./verification";
export { isVerifiedArtifact } from "./verification";

export type PutArtifactInput = {
  content: AsyncIterable<Uint8Array>;
  expectedDigest: string;
  expectedSizeBytes: number;
  maxSizeBytes: number;
};

export type VerifyArtifactInput = {
  expectedDigest: string;
  expectedSizeBytes: number;
};

export type ReadArtifactInput = {
  artifact: VerifiedArtifact;
  maxSizeBytes: number;
};

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<VerifiedArtifact>;
  verify(input: VerifyArtifactInput): Promise<VerifiedArtifact | undefined>;
  read(input: ReadArtifactInput): AsyncIterable<Uint8Array>;
}

export type ArtifactStoreErrorCode =
  | "digest_mismatch"
  | "invalid_capability"
  | "invalid_digest"
  | "invalid_size"
  | "size_limit_exceeded"
  | "size_mismatch"
  | "store_unavailable";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactStoreError";
  }
}
