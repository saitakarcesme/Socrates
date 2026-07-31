import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  runnerOwnershipLabels,
  type SandboxAttemptIdentity,
} from "../oci/identity";
import {
  resolveMaterializedSourceSnapshot,
  type MaterializedSourceSnapshot,
} from "../source/capability";
import {
  completeMaterializedRuntimeRequestRelease,
  issueMaterializedRuntimeRequest,
  prepareMaterializedRuntimeRequestRelease,
  type MaterializedRuntimeRequest,
} from "./capability";

export type RuntimeRequestMaterializerOptions = Readonly<{
  deploymentId: string;
  runnerId: string;
  maximumBytes: number;
}>;

export class RuntimeRequestMaterializer {
  readonly #deploymentId: string;
  readonly #runnerId: string;
  readonly #maximumBytes: number;

  constructor(options: RuntimeRequestMaterializerOptions) {
    runnerOwnershipLabels(options.deploymentId, options.runnerId);
    if (
      !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 1
    ) {
      throw new RangeError("maximumBytes must be a positive safe integer.");
    }
    this.#deploymentId = options.deploymentId;
    this.#runnerId = options.runnerId;
    this.#maximumBytes = options.maximumBytes;
  }

  async materialize(input: {
    bytes: Uint8Array;
    identity: SandboxAttemptIdentity;
    source: MaterializedSourceSnapshot;
  }): Promise<MaterializedRuntimeRequest> {
    if (input.identity.runnerId !== this.#runnerId) {
      throw new TypeError("Request attempt does not belong to this runner.");
    }
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > this.#maximumBytes
    ) {
      throw new RangeError(
        "Runtime request exceeds its materialization limit.",
      );
    }
    const sourcePath = resolveMaterializedSourceSnapshot(
      input.source,
      this.#deploymentId,
      input.identity,
    );
    const requestPath = join(
      dirname(sourcePath),
      `request-${randomUUID().replaceAll("-", "")}.bin`,
    );
    const handle = await open(
      requestPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(requestPath, 0o444);
    } catch (error) {
      await rm(requestPath, { force: true });
      throw error;
    }
    return issueMaterializedRuntimeRequest({
      path: requestPath,
      deploymentId: this.#deploymentId,
      identity: input.identity,
      digest: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`,
      sizeBytes: input.bytes.byteLength,
    });
  }

  async release(capability: MaterializedRuntimeRequest): Promise<void> {
    const path = prepareMaterializedRuntimeRequestRelease(
      capability,
      this.#deploymentId,
      this.#runnerId,
    );
    if (!path) return;
    await rm(path, { force: true });
    completeMaterializedRuntimeRequestRelease(capability);
  }
}
