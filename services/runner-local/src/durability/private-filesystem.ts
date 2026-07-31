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

export type DurabilityFaultPoint =
  | "after_directory_sync"
  | "after_immutable_publish"
  | "after_replace"
  | "after_temp_sync"
  | "after_temp_unlink"
  | "after_temp_write"
  | "before_temp_open";

export type DurabilityFaultInjector = (
  point: DurabilityFaultPoint,
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

export type DurabilityErrorFactory = (
  code: "invalid_configuration" | "corrupt",
  message: string,
  options?: ErrorOptions,
) => Error;

export function isMissing(error: unknown): boolean {
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

export class PrivateFilesystem {
  readonly rootPath: string;
  readonly #directorySync: DirectorySync;
  readonly #injectFault: DurabilityFaultInjector;
  readonly #error: DurabilityErrorFactory;

  constructor(options: {
    rootPath: string;
    directorySync?: DirectorySync;
    injectFault?: DurabilityFaultInjector;
    error: DurabilityErrorFactory;
  }) {
    if (!isAbsolute(options.rootPath)) {
      throw options.error(
        "invalid_configuration",
        "The durability root must be an absolute path.",
      );
    }
    this.rootPath = resolve(options.rootPath);
    if (this.rootPath === parse(this.rootPath).root) {
      throw options.error(
        "invalid_configuration",
        "The filesystem root cannot be used as a durability root.",
      );
    }
    this.#directorySync = options.directorySync ?? new NodeDirectorySync();
    this.#injectFault = options.injectFault ?? (() => undefined);
    this.#error = options.error;
  }

  async ensurePrivateDirectory(path: string, label: string): Promise<void> {
    const contained = this.contained(path);
    await mkdir(contained, { recursive: true, mode: 0o700 });
    await this.requireDirectory(contained, label);
    await chmod(contained, 0o700);
    if (process.platform !== "linux") return;
    const metadata = await lstat(contained);
    if ((metadata.mode & 0o077) !== 0) {
      throw this.#error("corrupt", `${label} must use a private mode.`);
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw this.#error("corrupt", `${label} must be owned by the runner.`);
    }
  }

  async requireDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(this.contained(path));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw this.#error("corrupt", `${label} must be a real directory.`);
    }
  }

  async requireRegularFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(this.contained(path));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw this.#error("corrupt", `${label} must be a regular file.`);
    }
    if (process.platform === "linux") {
      if ((metadata.mode & 0o077) !== 0 || metadata.nlink !== 1) {
        throw this.#error(
          "corrupt",
          `${label} must be private and have exactly one directory entry.`,
        );
      }
      if (
        typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()
      ) {
        throw this.#error("corrupt", `${label} must be owned by the runner.`);
      }
    }
  }

  async readOptional(path: string, label: string): Promise<Uint8Array | null> {
    const contained = this.contained(path);
    try {
      await this.requireRegularFile(contained, label);
      return await readFile(contained);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readRequired(path: string, label: string): Promise<Uint8Array> {
    const contained = this.contained(path);
    await this.requireRegularFile(contained, label);
    return readFile(contained);
  }

  async publishImmutable(
    directory: string,
    finalName: string,
    bytes: Uint8Array,
    label: string,
  ): Promise<void> {
    const containedDirectory = this.contained(directory);
    const finalPath = this.contained(join(containedDirectory, finalName));
    const temporaryPath = this.contained(
      join(containedDirectory, `.immutable.tmp-${randomUUID()}`),
    );
    await this.#writeSyncedTemporary(temporaryPath, bytes);
    let publicationError: unknown;
    try {
      await link(temporaryPath, finalPath);
      await this.#injectFault("after_immutable_publish");
    } catch (error) {
      if (isExisting(error)) {
        try {
          await this.requireRegularFile(finalPath, `Existing ${label}`);
          const existing = await readFile(finalPath);
          if (!existing.equals(Buffer.from(bytes))) {
            publicationError = this.#error(
              "corrupt",
              `An immutable ${label} conflicts with existing bytes.`,
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
              `Immutable ${label} publication and temporary cleanup failed.`,
            )
          : cleanupError;
      }
    }
    if (publicationError) throw publicationError;
    await this.#injectFault("after_temp_unlink");
    await this.syncDirectory(containedDirectory);
  }

  async replaceMutable(
    directory: string,
    finalName: string,
    temporaryPrefix: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const containedDirectory = this.contained(directory);
    const finalPath = this.contained(join(containedDirectory, finalName));
    const temporaryPath = this.contained(
      join(containedDirectory, `.${temporaryPrefix}.tmp-${randomUUID()}`),
    );
    await this.#writeSyncedTemporary(temporaryPath, bytes);
    await rename(temporaryPath, finalPath);
    await this.#injectFault("after_replace");
    await this.syncDirectory(containedDirectory);
  }

  async deleteFile(directory: string, name: string): Promise<void> {
    const containedDirectory = this.contained(directory);
    try {
      await unlink(this.contained(join(containedDirectory, name)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.syncDirectory(containedDirectory);
  }

  async cleanupTemporaryFiles(
    directory: string,
    allowedName: RegExp,
    invalidMessage: string,
  ): Promise<void> {
    const containedDirectory = this.contained(directory);
    let changed = false;
    for (const entry of await readdir(containedDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.name.startsWith(".")) continue;
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !allowedName.test(entry.name)
      ) {
        throw this.#error("corrupt", invalidMessage);
      }
      await unlink(this.contained(join(containedDirectory, entry.name)));
      changed = true;
    }
    if (changed) await this.#directorySync.sync(containedDirectory);
  }

  async totalBytes(): Promise<number> {
    return this.#directoryBytes(this.rootPath);
  }

  contained(path: string): string {
    const resolved = resolve(path);
    if (
      resolved !== this.rootPath &&
      !resolved.startsWith(`${this.rootPath}${sep}`)
    ) {
      throw this.#error(
        "corrupt",
        "A durability path escaped its configured root.",
      );
    }
    return resolved;
  }

  async syncDirectory(directory: string): Promise<void> {
    await this.#directorySync.sync(this.contained(directory));
    await this.#injectFault("after_directory_sync");
  }

  async #writeSyncedTemporary(
    temporaryPath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.#injectFault("before_temp_open");
    const handle = await open(this.contained(temporaryPath), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await this.#injectFault("after_temp_write");
      await handle.sync();
      await this.#injectFault("after_temp_sync");
    } finally {
      await handle.close();
    }
  }

  async #directoryBytes(directory: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.contained(directory), {
      withFileTypes: true,
    })) {
      const path = this.contained(join(directory, entry.name));
      if (entry.isSymbolicLink()) {
        throw this.#error(
          "corrupt",
          "Durability roots cannot contain symlinks.",
        );
      }
      if (entry.isDirectory()) {
        total += await this.#directoryBytes(path);
      } else if (entry.isFile()) {
        total += (await lstat(path)).size;
      } else {
        throw this.#error(
          "corrupt",
          "Durability roots can contain only directories and regular files.",
        );
      }
      if (!Number.isSafeInteger(total)) {
        throw this.#error("corrupt", "Durability byte accounting overflowed.");
      }
    }
    return total;
  }
}
