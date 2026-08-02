import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

export type ProcessRequest = Readonly<{
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  workingDirectory: string;
  timeoutMs: number;
  maximumOutputBytes: number;
  stdin?: Uint8Array;
  maximumInputBytes?: number;
  signal?: AbortSignal;
}>;

export type ProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
  durationMs: number;
}>;

export interface ProcessExecutor {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  constructor(
    readonly code: "aborted" | "output_limit" | "spawn" | "timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcessExecutionError";
  }
}

function exactEnvironment(
  candidate: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("Process environment is invalid.");
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Process environment is invalid.");
  }
  const keys = Reflect.ownKeys(candidate);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Process environment is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  let aggregateBytes = 0;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      key.includes("=") ||
      descriptor.value.includes("\0")
    ) {
      throw new TypeError("Process environment is invalid.");
    }
    aggregateBytes +=
      Buffer.byteLength(key, "utf8") +
      Buffer.byteLength(descriptor.value, "utf8");
    if (aggregateBytes > 65_536) {
      throw new RangeError("Process environment exceeds its byte limit.");
    }
    Object.defineProperty(environment, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return Object.freeze(environment);
}

function assertRequest(request: ProcessRequest): NodeJS.ProcessEnv {
  if (!request.executable || request.executable.includes("\0")) {
    throw new TypeError("Process executable is invalid.");
  }
  if (
    !request.workingDirectory ||
    request.workingDirectory.includes("\0") ||
    !isAbsolute(request.workingDirectory)
  ) {
    throw new TypeError("Process working directory is invalid.");
  }
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maximumOutputBytes) ||
    request.maximumOutputBytes < 1
  ) {
    throw new RangeError("Process bounds must be positive safe integers.");
  }
  if (request.arguments.some((argument) => argument.includes("\0"))) {
    throw new TypeError("Process arguments cannot contain null bytes.");
  }
  if (request.stdin) {
    if (
      !(request.stdin instanceof Uint8Array) ||
      !Number.isSafeInteger(request.maximumInputBytes) ||
      (request.maximumInputBytes ?? 0) < 1 ||
      request.stdin.byteLength > (request.maximumInputBytes ?? 0)
    ) {
      throw new RangeError("Process input exceeds its declared byte limit.");
    }
  } else if (request.maximumInputBytes !== undefined) {
    throw new TypeError("A process input limit requires stdin bytes.");
  }
  return exactEnvironment(request.environment);
}

export class NodeProcessExecutor implements ProcessExecutor {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const environment = assertRequest(request);
    if (request.signal?.aborted) {
      throw new ProcessExecutionError(
        "aborted",
        "Process request was aborted.",
      );
    }

    const startedAt = performance.now();
    const child = spawn(request.executable, [...request.arguments], {
      env: environment,
      cwd: request.workingDirectory,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: ProcessExecutionError | undefined;

    const stop = (error: ProcessExecutionError): void => {
      terminalError ??= error;
      child.kill("SIGKILL");
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maximumOutputBytes) {
        stop(
          new ProcessExecutionError(
            "output_limit",
            "Process output exceeded its byte limit.",
          ),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin);

    const onAbort = () =>
      stop(
        new ProcessExecutionError("aborted", "Process request was aborted."),
      );
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () =>
        stop(
          new ProcessExecutionError(
            "timeout",
            `Process exceeded ${request.timeoutMs}ms.`,
          ),
        ),
      request.timeoutMs,
    );

    try {
      const outcome = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", (cause) =>
          reject(
            new ProcessExecutionError("spawn", "Failed to start process.", {
              cause,
            }),
          ),
        );
        child.once("close", (exitCode, signal) =>
          resolve({ exitCode, signal }),
        );
      });
      if (terminalError) throw terminalError;
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      return {
        ...outcome,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
        stdoutBytes: Uint8Array.from(stdoutBuffer),
        stderrBytes: Uint8Array.from(stderrBuffer),
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
