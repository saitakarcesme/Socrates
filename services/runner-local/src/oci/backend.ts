import {
  createSandboxOwnership,
  ownershipFilterArguments,
  runnerOwnershipLabels,
  sandboxAttemptKey,
} from "./identity";
import { parseNativeSpec, verifyNativeSpec } from "./native-spec";
import { buildCreateArguments } from "./profile";

import type { SandboxAttemptIdentity, SandboxOwnership } from "./identity";
import type { ProcessExecutor, ProcessResult } from "./process";
import type {
  AdmittedSandboxImage,
  SandboxCommand,
  SandboxResourceProfile,
} from "./profile";
import type { ReadinessVerifier, SandboxReadiness } from "./readiness";

type JsonObject = Record<string, unknown>;

export type SandboxExecution = Readonly<{
  identity: SandboxAttemptIdentity;
  image: AdmittedSandboxImage;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
  signal?: AbortSignal;
}>;

export type SandboxExecutionResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}>;

export type NerdctlSandboxBackendOptions = Readonly<{
  deploymentId: string;
  runnerId: string;
  executable?: string;
  readinessTtlMs?: number;
  controlTimeoutMs?: number;
  executionTimeoutMs?: number;
  maximumControlOutputBytes?: number;
  maximumExecutionOutputBytes?: number;
  now?: () => number;
}>;

type ActiveSandbox = {
  ownership: SandboxOwnership;
  identity: SandboxAttemptIdentity;
};

export class SandboxBackendError extends Error {
  constructor(
    readonly code:
      "conflict" | "engine" | "identity_mismatch" | "image_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxBackendError";
  }
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function parseObject(result: ProcessResult, description: string): JsonObject {
  if (result.exitCode !== 0) {
    throw new SandboxBackendError(
      "engine",
      `${description} exited ${result.exitCode}.`,
    );
  }
  try {
    return object(JSON.parse(result.stdout) as unknown);
  } catch (cause) {
    throw new SandboxBackendError(
      "engine",
      `${description} returned invalid JSON.`,
      { cause },
    );
  }
}

function inspectOwnership(
  inspection: JsonObject,
  ownership: SandboxOwnership,
  image: AdmittedSandboxImage,
): void {
  const config = object(inspection["Config"]);
  const labels = object(config["Labels"]);
  for (const [name, expected] of Object.entries(ownership.labels)) {
    if (labels[name] !== expected) {
      throw new SandboxBackendError(
        "identity_mismatch",
        `Container ownership label ${name} does not match.`,
      );
    }
  }
  const observedImage = [inspection["Image"], config["Image"]].find(
    (value): value is string => typeof value === "string",
  );
  if (
    !observedImage ||
    (observedImage !== image.digest &&
      observedImage !== image.reference &&
      !observedImage.endsWith(`@${image.digest}`))
  ) {
    throw new SandboxBackendError(
      "image_mismatch",
      "Container image does not match the admitted digest.",
    );
  }
}

export class NerdctlSandboxBackend {
  private readonly executable: string;
  private readonly readinessTtlMs: number;
  private readonly controlTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly maximumControlOutputBytes: number;
  private readonly maximumExecutionOutputBytes: number;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveSandbox>();
  private readiness: { value: SandboxReadiness; expiresAt: number } | undefined;

  constructor(
    private readonly processes: ProcessExecutor,
    private readonly readinessVerifier: ReadinessVerifier,
    private readonly options: NerdctlSandboxBackendOptions,
  ) {
    if (!options.deploymentId.trim()) {
      throw new TypeError("deploymentId cannot be empty.");
    }
    runnerOwnershipLabels(options.deploymentId, options.runnerId);
    this.executable = options.executable ?? "nerdctl";
    this.readinessTtlMs = options.readinessTtlMs ?? 30_000;
    this.controlTimeoutMs = options.controlTimeoutMs ?? 10_000;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 60_000;
    this.maximumControlOutputBytes =
      options.maximumControlOutputBytes ?? 256 * 1_024;
    this.maximumExecutionOutputBytes =
      options.maximumExecutionOutputBytes ?? 256 * 1_024;
    this.now = options.now ?? Date.now;
  }

  invalidateReadiness(): void {
    this.readiness = undefined;
  }

  async attest(): Promise<SandboxReadiness> {
    if (this.readiness && this.readiness.expiresAt > this.now()) {
      return this.readiness.value;
    }
    const value = await this.readinessVerifier.verify();
    this.readiness = {
      value,
      expiresAt: this.now() + this.readinessTtlMs,
    };
    return value;
  }

  private run(
    arguments_: readonly string[],
    options: {
      timeoutMs?: number;
      maximumOutputBytes?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ProcessResult> {
    return this.processes.run({
      executable: this.executable,
      arguments: arguments_,
      timeoutMs: options.timeoutMs ?? this.controlTimeoutMs,
      maximumOutputBytes:
        options.maximumOutputBytes ?? this.maximumControlOutputBytes,
      signal: options.signal,
    });
  }

  private async requireSuccess(
    arguments_: readonly string[],
    description: string,
  ): Promise<ProcessResult> {
    const result = await this.run(arguments_);
    if (result.exitCode !== 0) {
      this.invalidateReadiness();
      throw new SandboxBackendError(
        "engine",
        `${description} exited ${result.exitCode}: ${result.stderr.slice(0, 1_000)}`,
      );
    }
    return result;
  }

  async execute(input: SandboxExecution): Promise<SandboxExecutionResult> {
    const key = sandboxAttemptKey(input.identity);
    if (input.identity.runnerId !== this.options.runnerId) {
      throw new SandboxBackendError(
        "identity_mismatch",
        "Attempt runner does not own this backend.",
      );
    }
    if (this.active.has(key)) {
      throw new SandboxBackendError(
        "conflict",
        "This attempt already owns an active sandbox.",
      );
    }
    const readiness = await this.attest();
    if (readiness.architecture !== input.image.architecture) {
      throw new SandboxBackendError(
        "image_mismatch",
        "Admitted image architecture does not match the attested host.",
      );
    }
    const ownership = createSandboxOwnership(
      this.options.deploymentId,
      input.identity,
    );
    let created = false;
    try {
      await this.requireSuccess(
        buildCreateArguments({
          ownership,
          image: input.image,
          profile: input.profile,
          command: input.command,
        }),
        "nerdctl create",
      );
      created = true;
      this.active.set(key, { ownership, identity: input.identity });

      const compatible = parseObject(
        await this.requireSuccess(
          ["inspect", "--format", "{{json .}}", ownership.containerName],
          "nerdctl inspect",
        ),
        "nerdctl inspect",
      );
      inspectOwnership(compatible, ownership, input.image);
      const native = await this.requireSuccess(
        ["inspect", "--mode", "native", ownership.containerName],
        "nerdctl native inspect",
      );
      verifyNativeSpec(parseNativeSpec(native.stdout), input.profile);

      const result = await this.run(
        ["start", "--attach", ownership.containerName],
        {
          timeoutMs: this.executionTimeoutMs,
          maximumOutputBytes: this.maximumExecutionOutputBytes,
          signal: input.signal,
        },
      );
      if (result.exitCode === null) {
        throw new SandboxBackendError(
          "engine",
          "Sandbox exited without an exit code.",
        );
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    } finally {
      if (created) await this.removeOwned(ownership);
      this.active.delete(key);
    }
  }

  async cancel(
    identity: SandboxAttemptIdentity,
    gracePeriodMs: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(gracePeriodMs) ||
      gracePeriodMs < 0 ||
      gracePeriodMs > 60_000
    ) {
      throw new RangeError("gracePeriodMs must be between 0 and 60000.");
    }
    const active = this.active.get(sandboxAttemptKey(identity));
    if (!active) return false;
    const seconds = Math.floor(gracePeriodMs / 1_000);
    try {
      await this.run(
        ["stop", "--time", String(seconds), active.ownership.containerName],
        {
          timeoutMs: Math.max(500, gracePeriodMs + 250),
        },
      );
    } finally {
      await this.run([
        "kill",
        "--signal",
        "KILL",
        active.ownership.containerName,
      ]);
      await this.removeOwned(active.ownership);
    }
    return true;
  }

  private async removeOwned(ownership: SandboxOwnership): Promise<void> {
    const result = await this.run(["rm", "--force", ownership.containerName]);
    if (
      result.exitCode !== 0 &&
      !/not found|no such container/i.test(`${result.stdout}\n${result.stderr}`)
    ) {
      this.invalidateReadiness();
      throw new SandboxBackendError(
        "engine",
        `Failed to remove owned sandbox: ${result.stderr.slice(0, 1_000)}`,
      );
    }
  }

  async recoverOwned(): Promise<number> {
    const labels = runnerOwnershipLabels(
      this.options.deploymentId,
      this.options.runnerId,
    );
    const filters = ownershipFilterArguments({ labels });
    const result = await this.requireSuccess(
      ["ps", "--all", "--quiet", ...filters],
      "nerdctl owned sandbox listing",
    );
    const identifiers = result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    let removed = 0;
    for (const identifier of identifiers) {
      const inspection = parseObject(
        await this.requireSuccess(
          ["inspect", "--format", "{{json .}}", identifier],
          "nerdctl recovery inspect",
        ),
        "nerdctl recovery inspect",
      );
      const observed = object(object(inspection["Config"])["Labels"]);
      if (
        Object.entries(labels).some(([name, value]) => observed[name] !== value)
      ) {
        throw new SandboxBackendError(
          "identity_mismatch",
          "Recovery candidate failed its ownership label check.",
        );
      }
      const name =
        typeof inspection["Name"] === "string"
          ? inspection["Name"].replace(/^\//, "")
          : identifier;
      const removal = await this.run(["rm", "--force", name]);
      if (removal.exitCode !== 0) {
        throw new SandboxBackendError(
          "engine",
          `Failed to recover owned sandbox ${name}.`,
        );
      }
      removed += 1;
    }
    return removed;
  }
}
