import type { ArtifactStore, VerifiedArtifact } from "@socrates/artifact-store";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";

import {
  runnerOwnershipLabels,
  sandboxAttemptKey,
  type SandboxAttemptIdentity,
} from "../oci/identity";
import {
  completeMaterializedSourceSnapshotRelease,
  issueMaterializedSourceSnapshot,
  prepareMaterializedSourceSnapshotRelease,
  type MaterializedSourceSnapshot,
} from "./capability";
import {
  canonicalSourcePath,
  SourcePathRegistry,
  type SourcePathLimits,
  validateSourcePathLimits,
} from "./path-policy";

export const sourceSnapshotMediaType =
  "application/vnd.socrates.source-snapshot.v1+tar";

export type SourceSnapshotLimits = SourcePathLimits &
  Readonly<{
    maximumArchiveBytes: number;
    maximumExpandedBytes: number;
    maximumEntries: number;
    maximumFileBytes: number;
  }>;

export type MaterializeSourceSnapshotInput = Readonly<{
  artifact: VerifiedArtifact;
  identity: SandboxAttemptIdentity;
}>;

export type SourceSnapshotMaterializerOptions = Readonly<{
  root: string;
  deploymentId: string;
  runnerId: string;
  limits: SourceSnapshotLimits;
}>;

type SnapshotManifest = Readonly<{
  schemaVersion: 1;
  deployment: string;
  runnerId: string;
  attemptKey: string;
  fence: number;
  digest: string;
}>;

const publishedNamePattern = /^source-[0-9a-f]{32}$/u;
const stagingNamePattern = /^staging-[0-9a-f]{32}$/u;

export class SourceSnapshotError extends Error {
  constructor(
    readonly code:
      | "archive_invalid"
      | "archive_limit"
      | "conflict"
      | "filesystem"
      | "identity_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceSnapshotError";
  }
}

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function validateLimits(limits: SourceSnapshotLimits): void {
  validateSourcePathLimits(limits);
  positiveLimit("maximumArchiveBytes", limits.maximumArchiveBytes);
  positiveLimit("maximumExpandedBytes", limits.maximumExpandedBytes);
  positiveLimit("maximumEntries", limits.maximumEntries);
  positiveLimit("maximumFileBytes", limits.maximumFileBytes);
  if (limits.maximumFileBytes > limits.maximumExpandedBytes) {
    throw new RangeError(
      "maximumFileBytes cannot exceed maximumExpandedBytes.",
    );
  }
}

function opaqueName(prefix: "source" | "staging"): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}

function assertDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path.startsWith(`..${sep}`) || path === "..") {
    throw new SourceSnapshotError(
      "filesystem",
      "Source path escaped its private root.",
    );
  }
}

function manifestDigest(deploymentId: string): string {
  return createHash("sha256").update(deploymentId).digest("hex");
}

export class SourceSnapshotMaterializer {
  readonly #root: string;
  readonly #deploymentId: string;
  readonly #runnerId: string;
  readonly #limits: SourceSnapshotLimits;
  readonly #attempts = new Map<string, MaterializedSourceSnapshot | symbol>();

  constructor(
    private readonly artifacts: ArtifactStore,
    options: SourceSnapshotMaterializerOptions,
  ) {
    if (!options.deploymentId.trim()) {
      throw new TypeError("deploymentId cannot be empty.");
    }
    runnerOwnershipLabels(options.deploymentId, options.runnerId);
    validateLimits(options.limits);
    this.#root = resolve(options.root);
    if (this.#root.includes(",") || this.#root.includes("\0")) {
      throw new TypeError("Source root is not mount-safe.");
    }
    this.#deploymentId = options.deploymentId;
    this.#runnerId = options.runnerId;
    this.#limits = Object.freeze({ ...options.limits });
  }

  async materialize(
    input: MaterializeSourceSnapshotInput,
  ): Promise<MaterializedSourceSnapshot> {
    if (input.identity.runnerId !== this.#runnerId) {
      throw new SourceSnapshotError(
        "identity_mismatch",
        "Source attempt does not belong to this runner.",
      );
    }
    if (input.artifact.sizeBytes > this.#limits.maximumArchiveBytes) {
      throw new SourceSnapshotError(
        "archive_limit",
        "Source archive exceeds the configured byte limit.",
      );
    }
    await this.#ensureRoot();
    const attemptKey = sandboxAttemptKey(input.identity);
    if (this.#attempts.has(attemptKey)) {
      throw new SourceSnapshotError(
        "conflict",
        "This attempt already owns source materialization state.",
      );
    }
    const reservation = Symbol(attemptKey);
    this.#attempts.set(attemptKey, reservation);

    const stagingRoot = join(this.#root, opaqueName("staging"));
    const treeRoot = join(stagingRoot, "tree");
    const publishedRoot = join(this.#root, opaqueName("source"));
    assertDescendant(this.#root, stagingRoot);
    assertDescendant(this.#root, publishedRoot);

    try {
      await mkdir(treeRoot, { recursive: true, mode: 0o700 });
      const accounting = await this.#extract(input, treeRoot);
      const manifest: SnapshotManifest = Object.freeze({
        schemaVersion: 1,
        deployment: manifestDigest(this.#deploymentId),
        runnerId: this.#runnerId,
        attemptKey: sandboxAttemptKey(input.identity),
        fence: input.identity.fence,
        digest: input.artifact.digest,
      });
      const manifestHandle = await open(
        join(stagingRoot, "manifest.json"),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await manifestHandle.writeFile(JSON.stringify(manifest), "utf8");
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      await chmod(treeRoot, 0o555);
      await rename(stagingRoot, publishedRoot);
      const capability = issueMaterializedSourceSnapshot({
        path: join(publishedRoot, "tree"),
        deploymentId: this.#deploymentId,
        identity: input.identity,
        digest: input.artifact.digest,
        archiveBytes: accounting.archiveBytes,
        expandedBytes: accounting.expandedBytes,
        entryCount: accounting.entryCount,
      });
      this.#attempts.set(attemptKey, capability);
      return capability;
    } catch (error) {
      if (this.#attempts.get(attemptKey) === reservation) {
        this.#attempts.delete(attemptKey);
      }
      await rm(stagingRoot, { recursive: true, force: true });
      await rm(publishedRoot, { recursive: true, force: true });
      if (error instanceof SourceSnapshotError) throw error;
      throw new SourceSnapshotError(
        "archive_invalid",
        "Source snapshot could not be materialized.",
        { cause: error },
      );
    }
  }

  async release(capability: MaterializedSourceSnapshot): Promise<void> {
    const treePath = prepareMaterializedSourceSnapshotRelease(
      capability,
      this.#deploymentId,
      this.#runnerId,
    );
    if (!treePath) return;
    const publishedRoot = dirname(treePath);
    assertDescendant(this.#root, publishedRoot);
    if (
      !publishedNamePattern.test(publishedRoot.slice(this.#root.length + 1))
    ) {
      throw new SourceSnapshotError(
        "filesystem",
        "Materialized source has an invalid owned directory.",
      );
    }
    await rm(publishedRoot, { recursive: true, force: true });
    completeMaterializedSourceSnapshotRelease(capability);
    if (this.#attempts.get(capability.attemptKey) === capability) {
      this.#attempts.delete(capability.attemptKey);
    }
  }

  async recoverOwned(): Promise<number> {
    await this.#ensureRoot();
    let removed = 0;
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(this.#root, entry.name);
      if (stagingNamePattern.test(entry.name)) {
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (!publishedNamePattern.test(entry.name)) continue;
      const manifest = await this.#readManifest(candidate);
      if (
        manifest?.schemaVersion === 1 &&
        manifest.deployment === manifestDigest(this.#deploymentId) &&
        manifest.runnerId === this.#runnerId &&
        /^[a-f0-9]{64}$/u.test(manifest.attemptKey) &&
        Number.isSafeInteger(manifest.fence) &&
        manifest.fence > 0 &&
        /^sha256:[a-f0-9]{64}$/u.test(manifest.digest)
      ) {
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  async #extract(
    input: MaterializeSourceSnapshotInput,
    treeRoot: string,
  ): Promise<{
    archiveBytes: number;
    expandedBytes: number;
    entryCount: number;
  }> {
    const hash = createHash("sha256");
    let archiveTail = Buffer.alloc(0);
    let archiveBytes = 0;
    let expandedBytes = 0;
    let entryCount = 0;
    const directories = new Set<string>();
    const registry = new SourcePathRegistry();
    const source = this.artifacts.read({
      artifact: input.artifact,
      maxSizeBytes: this.#limits.maximumArchiveBytes,
    });
    const verifiedSource = async function* () {
      for await (const chunk of source) {
        archiveBytes += chunk.byteLength;
        if (archiveBytes > input.artifact.sizeBytes) {
          throw new SourceSnapshotError(
            "archive_limit",
            "Source archive exceeds its verified size.",
          );
        }
        hash.update(chunk);
        archiveTail = Buffer.concat([archiveTail, chunk]).subarray(-1_024);
        yield chunk;
      }
    };
    const parser = extract({ allowUnknownFormat: false });
    const feeding = pipeline(Readable.from(verifiedSource()), parser);

    try {
      for await (const entry of parser) {
        entryCount += 1;
        if (entryCount > this.#limits.maximumEntries) {
          throw new SourceSnapshotError(
            "archive_limit",
            "Source archive contains too many entries.",
          );
        }
        const type = entry.header.type;
        if (type !== "file" && type !== "directory") {
          throw new SourceSnapshotError(
            "archive_invalid",
            "Source archive contains a forbidden entry type.",
          );
        }
        const size = entry.header.size ?? 0;
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new SourceSnapshotError(
            "archive_invalid",
            "Source entry has an invalid size.",
          );
        }
        if ((entry.header.mode ?? 0) & 0o7000) {
          throw new SourceSnapshotError(
            "archive_invalid",
            "Source entry requests unsafe permission bits.",
          );
        }
        const path = canonicalSourcePath(entry.header.name, type, this.#limits);
        registry.register(path, type);
        const destination = join(treeRoot, ...path.split("/"));
        assertDescendant(treeRoot, destination);
        await this.#ensureParents(treeRoot, path, directories);

        if (type === "directory") {
          if (size !== 0) {
            throw new SourceSnapshotError(
              "archive_invalid",
              "Source directory entry must be empty.",
            );
          }
          await this.#ensureDirectory(destination);
          directories.add(destination);
          for await (const chunk of entry) {
            if (chunk.byteLength !== 0) {
              throw new SourceSnapshotError(
                "archive_invalid",
                "Source directory entry emitted content.",
              );
            }
          }
          continue;
        }

        if (
          size > this.#limits.maximumFileBytes ||
          expandedBytes + size > this.#limits.maximumExpandedBytes
        ) {
          throw new SourceSnapshotError(
            "archive_limit",
            "Source entry exceeds an expanded-byte limit.",
          );
        }
        const handle = await open(
          destination,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        let written = 0;
        try {
          for await (const chunk of entry) {
            written += chunk.byteLength;
            if (written > size) {
              throw new SourceSnapshotError(
                "archive_invalid",
                "Source entry exceeds its declared size.",
              );
            }
            await handle.writeFile(chunk);
          }
          if (written !== size) {
            throw new SourceSnapshotError(
              "archive_invalid",
              "Source entry does not match its declared size.",
            );
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        expandedBytes += written;
        await chmod(
          destination,
          (entry.header.mode ?? 0) & 0o111 ? 0o555 : 0o444,
        );
      }
      await feeding;
    } catch (error) {
      parser.destroy(error instanceof Error ? error : undefined);
      await feeding.catch(() => undefined);
      if (error instanceof SourceSnapshotError) throw error;
      throw new SourceSnapshotError(
        "archive_invalid",
        "Source archive is malformed.",
        { cause: error },
      );
    }

    if (
      archiveBytes !== input.artifact.sizeBytes ||
      `sha256:${hash.digest("hex")}` !== input.artifact.digest
    ) {
      throw new SourceSnapshotError(
        "archive_invalid",
        "Source archive identity changed during materialization.",
      );
    }
    if (
      archiveBytes < 1_024 ||
      archiveBytes % 512 !== 0 ||
      archiveTail.byteLength < 1_024 ||
      archiveTail.some((byte) => byte !== 0)
    ) {
      throw new SourceSnapshotError(
        "archive_invalid",
        "Source archive has an invalid POSIX terminator.",
      );
    }
    await Promise.all(
      [...directories]
        .sort((left, right) => right.length - left.length)
        .map((path) => chmod(path, 0o555)),
    );
    return { archiveBytes, expandedBytes, entryCount };
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SourceSnapshotError(
        "filesystem",
        "Source root must be a real private directory.",
      );
    }
    await chmod(this.#root, 0o700);
  }

  async #ensureParents(
    treeRoot: string,
    path: string,
    directories: Set<string>,
  ): Promise<void> {
    const components = path.split("/").slice(0, -1);
    let current = treeRoot;
    for (const component of components) {
      current = join(current, component);
      assertDescendant(treeRoot, current);
      try {
        const metadata = await lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new SourceSnapshotError(
            "filesystem",
            "Source parent is not a real directory.",
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          await mkdir(current, { mode: 0o700 });
          directories.add(current);
          continue;
        }
        throw error;
      }
    }
  }

  async #ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SourceSnapshotError(
          "filesystem",
          "Source directory entry conflicts with a non-directory.",
        );
      }
    }
  }

  async #readManifest(root: string): Promise<SnapshotManifest | undefined> {
    try {
      const handle = await open(
        join(root, "manifest.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 4_096) return undefined;
        const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
        return typeof parsed === "object" && parsed !== null
          ? (parsed as SnapshotManifest)
          : undefined;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
