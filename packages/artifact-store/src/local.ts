import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  ArtifactStoreError,
  type ArtifactStore,
  type PutArtifactInput,
  type ReadArtifactInput,
  type VerifiedArtifact,
  type VerifyArtifactInput,
} from "./index";
import { isVerifiedArtifact, issueVerifiedArtifact } from "./verification";

const digestPattern = /^sha256:([a-f0-9]{64})$/;

type ValidatedIdentity = {
  digest: string;
  hex: string;
  sizeBytes: number;
};

function validateIdentity(
  digest: string,
  sizeBytes: number,
): ValidatedIdentity {
  const match = digestPattern.exec(digest);
  if (!match?.[1]) {
    throw new ArtifactStoreError(
      "invalid_digest",
      "Artifact digest must be a lowercase SHA-256 identity.",
    );
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ArtifactStoreError(
      "invalid_size",
      "Artifact size must be a non-negative safe integer.",
    );
  }
  return { digest, hex: match[1], sizeBytes };
}

export class LocalContentAddressedArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #objectsRoot: string;
  readonly #temporaryRoot: string;

  constructor(root: string) {
    this.#root = resolve(root);
    this.#objectsRoot = join(this.#root, "objects");
    this.#temporaryRoot = join(this.#root, "temporary");
  }

  async put(input: PutArtifactInput): Promise<VerifiedArtifact> {
    const identity = validateIdentity(
      input.expectedDigest,
      input.expectedSizeBytes,
    );
    if (!Number.isSafeInteger(input.maxSizeBytes) || input.maxSizeBytes < 0) {
      throw new ArtifactStoreError(
        "invalid_size",
        "Artifact maximum size must be a non-negative safe integer.",
      );
    }
    if (identity.sizeBytes > input.maxSizeBytes) {
      throw new ArtifactStoreError(
        "size_limit_exceeded",
        "Expected artifact size exceeds the upload limit.",
      );
    }

    await mkdir(this.#temporaryRoot, { recursive: true });
    const temporaryPath = join(this.#temporaryRoot, randomUUID());
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let writtenBytes = 0;

    try {
      for await (const chunk of input.content) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ArtifactStoreError(
            "store_unavailable",
            "Artifact content yielded a non-binary chunk.",
          );
        }
        writtenBytes += chunk.byteLength;
        if (
          writtenBytes > input.maxSizeBytes ||
          writtenBytes > identity.sizeBytes
        ) {
          throw new ArtifactStoreError(
            "size_limit_exceeded",
            "Artifact content exceeds its declared or maximum size.",
          );
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporaryPath, { force: true });
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "store_unavailable",
        "Artifact content could not be written.",
        { cause: error },
      );
    }
    await handle.close();

    try {
      if (writtenBytes !== identity.sizeBytes) {
        throw new ArtifactStoreError(
          "size_mismatch",
          "Artifact content does not match its declared size.",
        );
      }
      const actualDigest = `sha256:${hash.digest("hex")}`;
      if (actualDigest !== identity.digest) {
        throw new ArtifactStoreError(
          "digest_mismatch",
          "Artifact content does not match its declared digest.",
        );
      }

      const finalPath = this.#objectPath(identity.hex);
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(temporaryPath, finalPath);
      } catch (error) {
        if (!(await this.#matchesObject(finalPath, identity))) {
          throw new ArtifactStoreError(
            "store_unavailable",
            "Artifact object could not be published.",
            { cause: error },
          );
        }
      }
      return issueVerifiedArtifact(identity.digest, identity.sizeBytes);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async verify(
    input: VerifyArtifactInput,
  ): Promise<VerifiedArtifact | undefined> {
    const identity = validateIdentity(
      input.expectedDigest,
      input.expectedSizeBytes,
    );
    const objectPath = this.#objectPath(identity.hex);
    if (!(await this.#matchesObject(objectPath, identity))) return undefined;
    return issueVerifiedArtifact(identity.digest, identity.sizeBytes);
  }

  read(input: ReadArtifactInput): AsyncIterable<Uint8Array> {
    if (!isVerifiedArtifact(input.artifact)) {
      throw new ArtifactStoreError(
        "invalid_capability",
        "Artifact reads require a verified capability.",
      );
    }
    const identity = validateIdentity(
      input.artifact.digest,
      input.artifact.sizeBytes,
    );
    if (!Number.isSafeInteger(input.maxSizeBytes) || input.maxSizeBytes < 0) {
      throw new ArtifactStoreError(
        "invalid_size",
        "Artifact read maximum must be a non-negative safe integer.",
      );
    }
    if (identity.sizeBytes > input.maxSizeBytes) {
      throw new ArtifactStoreError(
        "size_limit_exceeded",
        "Verified artifact exceeds the read limit.",
      );
    }

    let consumed = false;
    const readVerified = () => this.#readVerified(identity, input.maxSizeBytes);
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        if (consumed) {
          throw new ArtifactStoreError(
            "invalid_capability",
            "Artifact content streams can be consumed only once.",
          );
        }
        consumed = true;
        return readVerified();
      },
    };
  }

  #objectPath(hex: string): string {
    return join(this.#objectsRoot, hex.slice(0, 2), hex.slice(2));
  }

  async *#readVerified(
    identity: ValidatedIdentity,
    maxSizeBytes: number,
  ): AsyncGenerator<Uint8Array> {
    const objectPath = this.#objectPath(identity.hex);
    let handle;
    try {
      handle = await open(
        objectPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== identity.sizeBytes) {
        throw new ArtifactStoreError(
          "size_mismatch",
          "Stored artifact no longer matches its verified size.",
        );
      }

      const hash = createHash("sha256");
      let readBytes = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(
          Math.min(64 * 1_024, identity.sizeBytes - readBytes),
        );
        if (buffer.byteLength === 0) break;
        const result = await handle.read(buffer, 0, buffer.byteLength, null);
        if (result.bytesRead === 0) break;
        readBytes += result.bytesRead;
        if (readBytes > maxSizeBytes || readBytes > identity.sizeBytes) {
          throw new ArtifactStoreError(
            "size_limit_exceeded",
            "Stored artifact exceeds its verified or maximum size.",
          );
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        yield chunk;
      }

      if (readBytes !== identity.sizeBytes) {
        throw new ArtifactStoreError(
          "size_mismatch",
          "Stored artifact no longer matches its verified size.",
        );
      }
      if (`sha256:${hash.digest("hex")}` !== identity.digest) {
        throw new ArtifactStoreError(
          "digest_mismatch",
          "Stored artifact no longer matches its verified digest.",
        );
      }
      const finalMetadata = await handle.stat();
      if (
        !finalMetadata.isFile() ||
        finalMetadata.size !== identity.sizeBytes
      ) {
        throw new ArtifactStoreError(
          "size_mismatch",
          "Stored artifact changed while it was being read.",
        );
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "store_unavailable",
        "Stored artifact could not be read.",
        { cause: error },
      );
    } finally {
      await handle?.close();
    }
  }

  async #matchesObject(
    objectPath: string,
    identity: ValidatedIdentity,
  ): Promise<boolean> {
    try {
      const metadata = await stat(objectPath);
      if (!metadata.isFile() || metadata.size !== identity.sizeBytes) {
        return false;
      }
      const handle = await open(objectPath, "r");
      const hash = createHash("sha256");
      try {
        for await (const chunk of handle.readableWebStream()) {
          hash.update(chunk);
        }
      } finally {
        await handle.close();
      }
      return `sha256:${hash.digest("hex")}` === identity.digest;
    } catch {
      return false;
    }
  }
}
