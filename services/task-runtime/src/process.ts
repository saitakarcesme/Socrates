import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export type RuntimeOutputStream = "stderr" | "stdout";

export type RuntimeProcessRequest = Readonly<{
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  timeoutMs: number;
  maximumOutputBytes: number;
  environment: Readonly<Record<string, string>>;
  onOutput: (stream: RuntimeOutputStream, chunk: Uint8Array) => void;
}>;

export type RuntimeProcessResult = Readonly<{
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputBytes: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}>;

export interface RuntimeProcessExecutor {
  run(request: RuntimeProcessRequest): Promise<RuntimeProcessResult>;
}

export class RuntimeProcessError extends Error {
  constructor(
    readonly code: "invalid_request" | "spawn_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeProcessError";
  }
}

const absoluteExecutablePattern =
  /^\/(?:[^/\0.][^/\0]*|\.(?!\.?\/)[^/\0]+)(?:\/[^/\0]+)*$/u;
const workspacePathPattern = /^\/workspace(?:\/(?!\.{1,2}(?:\/|$))[^/\0]+)*$/u;

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeProcessError(
      "invalid_request",
      `${name} must be a positive safe integer.`,
    );
  }
}

function validateRequest(request: RuntimeProcessRequest): void {
  if (
    !absoluteExecutablePattern.test(request.executable) ||
    request.executable.includes("/../") ||
    request.executable.endsWith("/..")
  ) {
    throw new RuntimeProcessError(
      "invalid_request",
      "Runtime executable must be a normalized absolute path.",
    );
  }
  if (
    request.arguments.length > 128 ||
    request.arguments.some(
      (argument) => argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    throw new RuntimeProcessError(
      "invalid_request",
      "Runtime command arguments are invalid.",
    );
  }
  if (!workspacePathPattern.test(request.workingDirectory)) {
    throw new RuntimeProcessError(
      "invalid_request",
      "Runtime working directory must stay within /workspace.",
    );
  }
  positiveInteger("timeoutMs", request.timeoutMs);
  positiveInteger("maximumOutputBytes", request.maximumOutputBytes);
  for (const [name, value] of Object.entries(request.environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(name) ||
      value.includes("\0") ||
      value.length > 4_096
    ) {
      throw new RuntimeProcessError(
        "invalid_request",
        "Runtime environment is invalid.",
      );
    }
  }
}

export class NodeRuntimeProcessExecutor implements RuntimeProcessExecutor {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot = "/workspace") {
    this.#workspaceRoot = resolve(workspaceRoot);
  }

  async run(request: RuntimeProcessRequest): Promise<RuntimeProcessResult> {
    validateRequest(request);
    const suffix = request.workingDirectory.slice("/workspace".length);
    const workingDirectory = resolve(
      this.#workspaceRoot,
      `.${suffix.replaceAll("/", sep)}`,
    );
    const relativePath = relative(this.#workspaceRoot, workingDirectory);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      resolve(this.#workspaceRoot, relativePath) !== workingDirectory
    ) {
      throw new RuntimeProcessError(
        "invalid_request",
        "Runtime working directory escaped the trusted workspace root.",
      );
    }
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.arguments], {
        cwd: workingDirectory,
        env: { ...request.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let outputBytes = 0;
      let outputLimitExceeded = false;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);

      const emit = (stream: RuntimeOutputStream, chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > request.maximumOutputBytes) {
          outputLimitExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        request.onOutput(stream, Uint8Array.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
      child.once("error", (cause) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(
          new RuntimeProcessError(
            "spawn_failed",
            "Runtime command could not be started.",
            { cause },
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          exitCode,
          signal,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          outputBytes,
          timedOut,
          outputLimitExceeded,
        });
      });
    });
  }
}
