import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

import { SpoolError } from "./contracts";

export type SpoolFaultPoint =
  | "after_directory_sync"
  | "after_immutable_publish"
  | "after_replace"
  | "after_temp_sync"
  | "after_temp_unlink"
  | "after_temp_write"
  | "before_temp_open";

export type SpoolFaultInjector = (
  point: SpoolFaultPoint,
) => void | Promise<void>;

export interface DirectorySync {
  sync(directoryPath: string): Promise<void>;
}

export class NodeDirectorySync implements DirectorySync {
  async sync(directoryPath: string): Promise<void> {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isExisting(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SpoolError("corrupt", `${label} must be a real directory.`);
  }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SpoolError("corrupt", `${label} must be a regular file.`);
  }
  if (process.platform === "linux") {
    if ((metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) {
      throw new SpoolError(
        "corrupt",
        `${label} must be private and have exactly one directory entry.`,
      );
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new SpoolError("corrupt", `${label} must be owned by the runner.`);
    }
  }
}

export class SpoolFilesystem {
  readonly #root: string;
  readonly #attemptsRoot: string;
  readonly #directorySync: DirectorySync;
  readonly #injectFault: SpoolFaultInjector;

  constructor(options: {
    rootPath: string;
    directorySync?: DirectorySync;
    injectFault?: SpoolFaultInjector;
  }) {
    if (!isAbsolute(options.rootPath)) {
      throw new SpoolError(
        "invalid_configuration",
        "The spool root must be an absolute path.",
      );
    }
    this.#root = resolve(options.rootPath);
    if (this.#root === parse(this.#root).root) {
      throw new SpoolError(
        "invalid_configuration",
        "The filesystem root cannot be used as a spool root.",
      );
    }
    this.#attemptsRoot = join(this.#root, "attempts");
    this.#directorySync = options.directorySync ?? new NodeDirectorySync();
    this.#injectFault = options.injectFault ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await requireDirectory(this.#root, "Spool root");
    await chmod(this.#root, 0o700);
    await this.#requirePrivateDirectory(this.#root, "Spool root");
    await mkdir(this.#attemptsRoot, { recursive: true, mode: 0o700 });
    await requireDirectory(this.#attemptsRoot, "Spool attempts root");
    await chmod(this.#attemptsRoot, 0o700);
    await this.#requirePrivateDirectory(
      this.#attemptsRoot,
      "Spool attempts root",
    );
    const rootEntries = await readdir(this.#root, { withFileTypes: true });
    if (
      rootEntries.length !== 1 ||
      rootEntries[0]?.name !== "attempts" ||
      !rootEntries[0].isDirectory() ||
      rootEntries[0].isSymbolicLink()
    ) {
      throw new SpoolError(
        "corrupt",
        "Spool root contains an unexpected entry.",
      );
    }
  }

  async listAttemptKeys(): Promise<readonly string[]> {
    const entries = await readdir(this.#attemptsRoot, { withFileTypes: true });
    const keys: string[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-f0-9]{64}$/u.test(entry.name)
      ) {
        throw new SpoolError(
          "corrupt",
          "Spool attempts root contains an unexpected entry.",
        );
      }
      keys.push(entry.name);
    }
    return Object.freeze(keys.sort());
  }

  async ensureAttempt(attemptKey: string): Promise<void> {
    this.#assertAttemptKey(attemptKey);
    const attemptPath = this.#attemptPath(attemptKey);
    const segmentsPath = this.#segmentsPath(attemptKey);
    await mkdir(attemptPath, { recursive: true, mode: 0o700 });
    await requireDirectory(attemptPath, "Spool attempt");
    await chmod(attemptPath, 0o700);
    await this.#requirePrivateDirectory(attemptPath, "Spool attempt");
    await mkdir(segmentsPath, { recursive: true, mode: 0o700 });
    await requireDirectory(segmentsPath, "Spool segments directory");
    await chmod(segmentsPath, 0o700);
    await this.#requirePrivateDirectory(
      segmentsPath,
      "Spool segments directory",
    );
  }

  async readManifest(attemptKey: string): Promise<Uint8Array | null> {
    return this.#readOptional(
      join(this.#attemptPath(attemptKey), "manifest.json"),
      "Spool manifest",
    );
  }

  async readAcknowledgement(attemptKey: string): Promise<Uint8Array | null> {
    return this.#readOptional(
      join(this.#attemptPath(attemptKey), "acknowledgement.json"),
      "Spool acknowledgement",
    );
  }

  async readCommit(attemptKey: string): Promise<Uint8Array | null> {
    return this.#readOptional(
      join(this.#attemptPath(attemptKey), "commit.json"),
      "Spool commit marker",
    );
  }

  async cleanupAttemptTemporary(attemptKey: string): Promise<void> {
    const directory = this.#attemptPath(attemptKey);
    await this.#validateAttemptEntries(directory);
    await this.#cleanupTemporaryFiles(directory);
    await this.#validateAttemptEntries(directory);
  }

  async publishManifest(attemptKey: string, bytes: Uint8Array): Promise<void> {
    await this.#publishImmutable(
      this.#attemptPath(attemptKey),
      "manifest.json",
      bytes,
    );
  }

  async publishCommit(attemptKey: string, bytes: Uint8Array): Promise<void> {
    await this.#publishImmutable(
      this.#attemptPath(attemptKey),
      "commit.json",
      bytes,
    );
  }

  async listSegmentNames(attemptKey: string): Promise<readonly string[]> {
    const directory = this.#segmentsPath(attemptKey);
    await this.#cleanupTemporaryFiles(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^\d{16}-\d{16}\.json$/u.test(entry.name)
      ) {
        throw new SpoolError(
          "corrupt",
          "Spool segment directory contains an unexpected entry.",
        );
      }
      names.push(entry.name);
    }
    return Object.freeze(names.sort());
  }

  async readSegment(attemptKey: string, name: string): Promise<Uint8Array> {
    this.#assertSegmentName(name);
    const path = join(this.#segmentsPath(attemptKey), name);
    await requireRegularFile(path, "Spool segment");
    return readFile(path);
  }

  async publishSegment(
    attemptKey: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.#assertSegmentName(name);
    await this.#publishImmutable(this.#segmentsPath(attemptKey), name, bytes);
  }

  async replaceAcknowledgement(
    attemptKey: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const directory = this.#attemptPath(attemptKey);
    const finalPath = join(directory, "acknowledgement.json");
    const temporaryPath = join(
      directory,
      `.acknowledgement.tmp-${randomUUID()}`,
    );
    await this.#writeSyncedTemporary(temporaryPath, bytes);
    await rename(temporaryPath, finalPath);
    await this.#injectFault("after_replace");
    await this.#directorySync.sync(directory);
    await this.#injectFault("after_directory_sync");
  }

  async deleteSegment(attemptKey: string, name: string): Promise<void> {
    this.#assertSegmentName(name);
    const directory = this.#segmentsPath(attemptKey);
    try {
      await unlink(join(directory, name));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.#directorySync.sync(directory);
    await this.#injectFault("after_directory_sync");
  }

  async totalBytes(): Promise<number> {
    return this.#directoryBytes(this.#root);
  }

  async #directoryBytes(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new SpoolError("corrupt", "Spool roots cannot contain symlinks.");
      }
      if (entry.isDirectory()) {
        total += await this.#directoryBytes(path);
      } else if (entry.isFile()) {
        total += (await lstat(path)).size;
      } else {
        throw new SpoolError(
          "corrupt",
          "Spool roots can contain only directories and regular files.",
        );
      }
      if (!Number.isSafeInteger(total)) {
        throw new SpoolError("corrupt", "Spool byte accounting overflowed.");
      }
    }
    return total;
  }

  async #publishImmutable(
    directory: string,
    finalName: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const finalPath = join(directory, finalName);
    const temporaryPath = join(directory, `.immutable.tmp-${randomUUID()}`);
    await this.#writeSyncedTemporary(temporaryPath, bytes);
    let publicationError: unknown;
    try {
      await link(temporaryPath, finalPath);
      await this.#injectFault("after_immutable_publish");
    } catch (error) {
      if (isExisting(error)) {
        try {
          await requireRegularFile(
            finalPath,
            "Existing immutable spool record",
          );
          const existing = await readFile(finalPath);
          if (!existing.equals(Buffer.from(bytes))) {
            publicationError = new SpoolError(
              "corrupt",
              "An immutable spool record conflicts with existing bytes.",
            );
          }
        } catch (comparisonError) {
          publicationError = comparisonError;
        }
      } else {
        publicationError = error;
      }
    }
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) {
        throw publicationError
          ? new AggregateError(
              [publicationError, cleanupError],
              "Immutable spool publication and temporary cleanup failed.",
            )
          : cleanupError;
      }
    }
    if (publicationError) throw publicationError;
    await this.#injectFault("after_temp_unlink");
    await this.#directorySync.sync(directory);
    await this.#injectFault("after_directory_sync");
  }

  async #writeSyncedTemporary(
    temporaryPath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.#injectFault("before_temp_open");
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await this.#injectFault("after_temp_write");
      await handle.sync();
      await this.#injectFault("after_temp_sync");
    } finally {
      await handle.close();
    }
  }

  async #readOptional(path: string, label: string): Promise<Uint8Array | null> {
    try {
      await requireRegularFile(path, label);
      return await readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #cleanupTemporaryFiles(directory: string): Promise<void> {
    let changed = false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.startsWith(".")) continue;
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^\.(?:immutable|acknowledgement)\.tmp-[0-9a-f-]{36}$/u.test(
          entry.name,
        )
      ) {
        throw new SpoolError(
          "corrupt",
          "Spool contains an invalid temporary entry.",
        );
      }
      await unlink(join(directory, entry.name));
      changed = true;
    }
    if (changed) await this.#directorySync.sync(directory);
  }

  async #validateAttemptEntries(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.name === "segments" &&
        entry.isDirectory() &&
        !entry.isSymbolicLink()
      ) {
        continue;
      }
      if (
        ["manifest.json", "commit.json", "acknowledgement.json"].includes(
          entry.name,
        ) &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      ) {
        continue;
      }
      if (
        /^\.(?:immutable|acknowledgement)\.tmp-[0-9a-f-]{36}$/u.test(
          entry.name,
        ) &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      ) {
        continue;
      }
      throw new SpoolError(
        "corrupt",
        "Spool attempt contains an unexpected entry.",
      );
    }
  }

  async #requirePrivateDirectory(path: string, label: string): Promise<void> {
    if (process.platform !== "linux") return;
    const metadata = await lstat(path);
    if ((metadata.mode & 0o077) !== 0) {
      throw new SpoolError("corrupt", `${label} must use a private mode.`);
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new SpoolError("corrupt", `${label} must be owned by the runner.`);
    }
  }

  #attemptPath(attemptKey: string): string {
    this.#assertAttemptKey(attemptKey);
    return this.#contained(join(this.#attemptsRoot, attemptKey));
  }

  #segmentsPath(attemptKey: string): string {
    return this.#contained(join(this.#attemptPath(attemptKey), "segments"));
  }

  #contained(path: string): string {
    const resolved = resolve(path);
    if (
      resolved !== this.#root &&
      !resolved.startsWith(`${this.#root}${sep}`)
    ) {
      throw new SpoolError(
        "corrupt",
        "Spool path escaped its configured root.",
      );
    }
    return resolved;
  }

  #assertAttemptKey(attemptKey: string): void {
    if (!/^[a-f0-9]{64}$/u.test(attemptKey)) {
      throw new SpoolError("corrupt", "Spool attempt key is invalid.");
    }
  }

  #assertSegmentName(name: string): void {
    if (!/^\d{16}-\d{16}\.json$/u.test(name)) {
      throw new SpoolError("corrupt", "Spool segment name is invalid.");
    }
  }
}
