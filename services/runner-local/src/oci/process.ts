import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export type ProcessRequest = Readonly<{
  executable: string;
  arguments: readonly string[];
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

export type NodeProcessExecutorOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
}>;

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

function assertRequest(request: ProcessRequest): void {
  if (!request.executable || request.executable.includes("\0")) {
    throw new TypeError("Process executable is invalid.");
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
}

export class NodeProcessExecutor implements ProcessExecutor {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: NodeProcessExecutorOptions = {}) {
    this.environment = { ...(options.environment ?? process.env) };
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    assertRequest(request);
    if (request.signal?.aborted) {
      throw new ProcessExecutionError(
        "aborted",
        "Process request was aborted.",
      );
    }

    const startedAt = performance.now();
    const child = spawn(request.executable, [...request.arguments], {
      env: this.environment,
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
