import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PrivateFilesystem,
  type DirectorySync,
  type DurabilityFaultInjector,
  type DurabilityFaultPoint,
} from "../durability/private-filesystem";
import { WorkJournalError } from "./contracts";

export type WorkJournalFaultPoint = DurabilityFaultPoint;
export type WorkJournalFaultInjector = DurabilityFaultInjector;
export type { DirectorySync };

const temporaryNamePattern = /^\.immutable\.tmp-[0-9a-f-]{36}$/u;
const keyPattern = /^[a-f0-9]{64}$/u;

export class WorkJournalFilesystem {
  readonly #root: string;
  readonly #workRoot: string;
  readonly #durability: PrivateFilesystem;

  constructor(options: {
    rootPath: string;
    directorySync?: DirectorySync;
    injectFault?: WorkJournalFaultInjector;
  }) {
    this.#durability = new PrivateFilesystem({
      ...options,
      error: (code, message, errorOptions) =>
        new WorkJournalError(code, message, errorOptions),
    });
    this.#root = this.#durability.rootPath;
    this.#workRoot = join(this.#root, "work");
  }

  async initialize(): Promise<void> {
    await this.#durability.ensurePrivateDirectory(
      this.#root,
      "Work journal root",
    );
    await this.#durability.ensurePrivateDirectory(
      this.#workRoot,
      "Work journal items root",
    );
    const entries = await readdir(this.#root, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0]?.name !== "work" ||
      !entries[0].isDirectory() ||
      entries[0].isSymbolicLink()
    ) {
      throw new WorkJournalError(
        "corrupt",
        "Work journal root contains an unexpected entry.",
      );
    }
  }

  async listKeys(): Promise<readonly string[]> {
    const entries = await readdir(this.#workRoot, { withFileTypes: true });
    const keys: string[] = [];
    for (const entry of entries) {
      if (
        !keyPattern.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new WorkJournalError(
          "corrupt",
          "Work journal items root contains an unexpected entry.",
        );
      }
      await this.#durability.requireDirectory(
        join(this.#workRoot, entry.name),
        "Work journal item",
      );
      keys.push(entry.name);
    }
    return Object.freeze(keys.sort());
  }

  async ensureItem(key: string): Promise<void> {
    this.#assertKey(key);
    await this.#durability.ensurePrivateDirectory(
      this.#itemPath(key),
      "Work journal item",
    );
  }

  async cleanup(key: string): Promise<void> {
    const directory = this.#itemPath(key);
    await this.#validateEntries(directory);
    await this.#durability.cleanupTemporaryFiles(
      directory,
      temporaryNamePattern,
      "Work journal item contains invalid temporary evidence.",
    );
    await this.#validateEntries(directory);
  }

  readManifest(key: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#itemPath(key), "manifest.json"),
      "Work manifest",
    );
  }

  readClaim(key: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#itemPath(key), "claim.json"),
      "Work claim",
    );
  }

  readRejection(key: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#itemPath(key), "rejection.json"),
      "Work rejection",
    );
  }

  readExecutionStart(key: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#itemPath(key), "execution-start.json"),
      "Work execution start",
    );
  }

  readCompletion(key: string): Promise<Uint8Array | null> {
    return this.#durability.readOptional(
      join(this.#itemPath(key), "completion.json"),
      "Work completion",
    );
  }

  publishManifest(key: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#itemPath(key),
      "manifest.json",
      bytes,
      "work manifest",
    );
  }

  publishClaim(key: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#itemPath(key),
      "claim.json",
      bytes,
      "work claim",
    );
  }

  publishRejection(key: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#itemPath(key),
      "rejection.json",
      bytes,
      "work rejection",
    );
  }

  publishExecutionStart(key: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#itemPath(key),
      "execution-start.json",
      bytes,
      "work execution start",
    );
  }

  publishCompletion(key: string, bytes: Uint8Array): Promise<void> {
    return this.#durability.publishImmutable(
      this.#itemPath(key),
      "completion.json",
      bytes,
      "work completion",
    );
  }

  totalBytes(): Promise<number> {
    return this.#durability.totalBytes();
  }

  async #validateEntries(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ([
          "manifest.json",
          "claim.json",
          "execution-start.json",
          "rejection.json",
          "completion.json",
        ].includes(entry.name) ||
          temporaryNamePattern.test(entry.name)) &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      )
        continue;
      throw new WorkJournalError(
        "corrupt",
        "Work journal item contains an unexpected entry.",
      );
    }
  }

  #itemPath(key: string): string {
    this.#assertKey(key);
    return this.#durability.contained(join(this.#workRoot, key));
  }

  #assertKey(key: string): void {
    if (!keyPattern.test(key))
      throw new WorkJournalError(
        "corrupt",
        "Work journal delivery key is invalid.",
      );
  }
}
