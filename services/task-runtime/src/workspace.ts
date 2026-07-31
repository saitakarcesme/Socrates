import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export type RuntimeWorkspaceLimits = Readonly<{
  maximumBytes: number;
  maximumEntries: number;
}>;

export type RuntimeWorkspaceResult = Readonly<{
  copiedBytes: number;
  entryCount: number;
}>;

export class RuntimeWorkspaceError extends Error {
  constructor(
    readonly code:
      | "copy_failed"
      | "invalid_limit"
      | "invalid_source"
      | "workspace_not_empty",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeWorkspaceError";
  }
}

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeWorkspaceError(
      "invalid_limit",
      `${name} must be a positive safe integer.`,
    );
  }
}

function assertDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) {
    throw new RuntimeWorkspaceError(
      "invalid_source",
      "Runtime copy path escaped its fixed root.",
    );
  }
}

export class RuntimeWorkspacePreparer {
  readonly #sourceRoot: string;
  readonly #workspaceRoot: string;

  constructor(sourceRoot = "/socrates/source", workspaceRoot = "/workspace") {
    this.#sourceRoot = resolve(sourceRoot);
    this.#workspaceRoot = resolve(workspaceRoot);
    if (this.#sourceRoot === this.#workspaceRoot) {
      throw new TypeError("Source and workspace roots must differ.");
    }
  }

  async prepare(
    limits: RuntimeWorkspaceLimits,
  ): Promise<RuntimeWorkspaceResult> {
    positiveLimit("maximumBytes", limits.maximumBytes);
    positiveLimit("maximumEntries", limits.maximumEntries);
    await this.#assertRoot(this.#sourceRoot, "invalid_source");
    await this.#assertRoot(this.#workspaceRoot, "workspace_not_empty");
    if ((await readdir(this.#workspaceRoot)).length !== 0) {
      throw new RuntimeWorkspaceError(
        "workspace_not_empty",
        "Runtime workspace must be empty before source copy.",
      );
    }

    const accounting = { copiedBytes: 0, entryCount: 0 };
    try {
      await this.#copyDirectory(
        this.#sourceRoot,
        this.#workspaceRoot,
        limits,
        accounting,
      );
      return Object.freeze({ ...accounting });
    } catch (error) {
      await this.#clearWorkspace();
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError(
        "copy_failed",
        "Runtime source tree could not be copied.",
        { cause: error },
      );
    }
  }

  async #copyDirectory(
    source: string,
    destination: string,
    limits: RuntimeWorkspaceLimits,
    accounting: { copiedBytes: number; entryCount: number },
  ): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      accounting.entryCount += 1;
      if (accounting.entryCount > limits.maximumEntries) {
        throw new RuntimeWorkspaceError(
          "invalid_limit",
          "Runtime source tree exceeds its entry limit.",
        );
      }
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      assertDescendant(this.#sourceRoot, sourcePath);
      assertDescendant(this.#workspaceRoot, destinationPath);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new RuntimeWorkspaceError(
          "invalid_source",
          "Runtime source tree contains a symbolic link.",
        );
      }
      if (metadata.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await this.#copyDirectory(
          sourcePath,
          destinationPath,
          limits,
          accounting,
        );
        await chmod(destinationPath, 0o755);
        continue;
      }
      if (!metadata.isFile()) {
        throw new RuntimeWorkspaceError(
          "invalid_source",
          "Runtime source tree contains a non-regular entry.",
        );
      }
      if (
        !Number.isSafeInteger(metadata.size) ||
        accounting.copiedBytes + metadata.size > limits.maximumBytes
      ) {
        throw new RuntimeWorkspaceError(
          "invalid_limit",
          "Runtime source tree exceeds its byte limit.",
        );
      }
      await this.#copyFile(
        sourcePath,
        destinationPath,
        metadata.size,
        (metadata.mode & 0o111) !== 0,
      );
      accounting.copiedBytes += metadata.size;
    }
  }

  async #copyFile(
    source: string,
    destination: string,
    expectedBytes: number,
    executable: boolean,
  ): Promise<void> {
    const sourceHandle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let destinationHandle: FileHandle | undefined;
    let copiedBytes = 0;
    try {
      destinationHandle = await open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      for await (const chunk of sourceHandle.readableWebStream()) {
        copiedBytes += chunk.byteLength;
        if (copiedBytes > expectedBytes) {
          throw new RuntimeWorkspaceError(
            "invalid_source",
            "Runtime source file changed while being copied.",
          );
        }
        await destinationHandle.writeFile(chunk);
      }
      if (copiedBytes !== expectedBytes) {
        throw new RuntimeWorkspaceError(
          "invalid_source",
          "Runtime source file changed while being copied.",
        );
      }
      await destinationHandle.sync();
    } finally {
      await sourceHandle.close();
      await destinationHandle?.close();
    }
    await chmod(destination, executable ? 0o755 : 0o644);
  }

  async #assertRoot(
    path: string,
    code: "invalid_source" | "workspace_not_empty",
  ): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new RuntimeWorkspaceError(
          code,
          "Runtime root must be a real directory.",
        );
      }
    } catch (error) {
      if (error instanceof RuntimeWorkspaceError) throw error;
      throw new RuntimeWorkspaceError(code, "Runtime root is unavailable.", {
        cause: error,
      });
    }
  }

  async #clearWorkspace(): Promise<void> {
    for (const entry of await readdir(this.#workspaceRoot)) {
      await rm(join(this.#workspaceRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }
}
