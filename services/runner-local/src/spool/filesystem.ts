import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  NodeDirectorySync,
  PrivateFilesystem,
  type DirectorySync,
  type DurabilityFaultInjector,
  type DurabilityFaultPoint,
} from "../durability/private-filesystem";
import { SpoolError } from "./contracts";

export { NodeDirectorySync };
export type SpoolFaultPoint = DurabilityFaultPoint;
export type SpoolFaultInjector = DurabilityFaultInjector;
export type { DirectorySync };

const temporaryNamePattern =
  /^\.(?:immutable|acknowledgement)\.tmp-[0-9a-f-]{36}$/u;

export class SpoolFilesystem {
  readonly #root: string;
  readonly #attemptsRoot: string;
  readonly #durability: PrivateFilesystem;

  constructor(options: {
    rootPath: string;
    directorySync?: DirectorySync;
    injectFault?: SpoolFaultInjector;
  }) {
    this.#durability = new PrivateFilesystem({
      rootPath: options.rootPath,
      directorySync: options.directorySync,
      injectFault: options.injectFault,
      error: (code, message, errorOptions) =>
        new SpoolError(code, message, errorOptions),
    });
    this.#root = this.#durability.rootPath;
    this.#attemptsRoot = join(this.#root, "attempts");
  }

  async initialize(): Promise<void> {
    await this.#durability.ensurePrivateDirectory(this.#root, "Spool root");
    await this.#durability.ensurePrivateDirectory(
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
    await this.#durability.ensurePrivateDirectory(
      this.#attemptPath(attemptKey),
      "Spool attempt",
    );
    await this.#durability.ensurePrivateDirectory(
      this.#segmentsPath(attemptKey),
      "Spool segments directory",
    );
  }

  readManifest(attemptKey: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#attemptPath(attemptKey), "manifest.json"),
      "Spool manifest",
    );
  }

  readAcknowledgement(attemptKey: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#attemptPath(attemptKey), "acknowledgement.json"),
      "Spool acknowledgement",
    );
  }

  readCommit(attemptKey: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#attemptPath(attemptKey), "commit.json"),
      "Spool commit marker",
    );
  }

  async cleanupAttemptTemporary(attemptKey: string): Promise<void> {
    const directory = this.#attemptPath(attemptKey);
    await this.#validateAttemptEntries(directory);
    await this.#durability.cleanupTemporaryFiles(
      directory,
      temporaryNamePattern,
      "Spool contains an invalid temporary entry.",
    );
    await this.#validateAttemptEntries(directory);
  }

  publishManifest(attemptKey: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#attemptPath(attemptKey),
      "manifest.json",
      bytes,
      "spool manifest",
    );
  }

  publishCommit(attemptKey: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#attemptPath(attemptKey),
      "commit.json",
      bytes,
      "spool commit marker",
    );
  }

  async listSegmentNames(attemptKey: string): Promise<readonly string[]> {
    const directory = this.#segmentsPath(attemptKey);
    await this.#durability.cleanupTemporaryFiles(
      directory,
      temporaryNamePattern,
      "Spool contains an invalid temporary entry.",
    );
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

  readSegment(attemptKey: string, name: string): Promise<Uint8Array> {
    this.#assertSegmentName(name);
    return this.#durability.readRequired(
      join(this.#segmentsPath(attemptKey), name),
      "Spool segment",
    );
  }

  publishSegment(
    attemptKey: string,
    name: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.#assertSegmentName(name);
    return this.#durability.publishImmutable(
      this.#segmentsPath(attemptKey),
      name,
      bytes,
      "spool segment",
    );
  }

  replaceAcknowledgement(attemptKey: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.replaceMutable(
      this.#attemptPath(attemptKey),
      "acknowledgement.json",
      "acknowledgement",
      bytes,
    );
  }

  deleteSegment(attemptKey: string, name: string): Promise<void> {
    this.#assertSegmentName(name);
    return this.#durability.deleteFile(this.#segmentsPath(attemptKey), name);
  }

  totalBytes(): Promise<number> {
    return this.#durability.totalBytes();
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
        temporaryNamePattern.test(entry.name) &&
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

  #attemptPath(attemptKey: string): string {
    this.#assertAttemptKey(attemptKey);
    return this.#durability.contained(join(this.#attemptsRoot, attemptKey));
  }

  #segmentsPath(attemptKey: string): string {
    return this.#durability.contained(
      join(this.#attemptPath(attemptKey), "segments"),
    );
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
