import { randomUUID } from "node:crypto";

import { assertAdmittedImage, assertInspectedImage } from "../image/capability";
import {
  createSandboxOwnership,
  ownershipFilterArguments,
  runnerOwnershipLabels,
  sandboxAttemptKey,
} from "./identity";
import { parseNativeSpec, verifyNativeSpec } from "./native-spec";
import { buildCreateArguments } from "./profile";
import {
  resolveMaterializedSourceSnapshot,
  type MaterializedSourceSnapshot,
} from "../source/capability";
import {
  resolveMaterializedRuntimeRequest,
  type MaterializedRuntimeRequest,
} from "../request/capability";

import type { SandboxAttemptIdentity, SandboxOwnership } from "./identity";
import type { ProcessExecutor, ProcessResult } from "./process";
import type {
  AdmittedSandboxImage,
  SandboxCommand,
  SandboxResourceProfile,
} from "./profile";
import type {
  InspectedSandboxImage,
  SandboxImageAuthority,
} from "../image/capability";
import type { ReadinessVerifier, SandboxReadiness } from "./readiness";

type JsonObject = Record<string, unknown>;

export type SandboxExecution = Readonly<{
  identity: SandboxAttemptIdentity;
  image: AdmittedSandboxImage;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
  source?: Readonly<{
    snapshot: MaterializedSourceSnapshot;
    expectedDigest: string;
  }>;
  request?: Readonly<{
    envelope: MaterializedRuntimeRequest;
    expectedDigest: string;
  }>;
  signal?: AbortSignal;
}>;

export type SandboxImageProbeExecution = Readonly<{
  identity: SandboxAttemptIdentity;
  image: InspectedSandboxImage;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
  signal?: AbortSignal;
}>;

export type SandboxRuntimeExecution = Omit<SandboxExecution, "command">;

export type SandboxExecutionResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
  durationMs: number;
}>;

type PreparedSandboxExecution = Readonly<{
  identity: SandboxAttemptIdentity;
  image: SandboxImageAuthority;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
  source?: SandboxExecution["source"];
  request?: SandboxExecution["request"];
  signal?: AbortSignal;
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
  image: SandboxImageAuthority,
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
  const observedImages = [inspection["Image"], config["Image"]].filter(
    (value): value is string => typeof value === "string",
  );
  if (
    !observedImages.some(
      (observedImage) =>
        observedImage === image.digest ||
        observedImage === image.configurationDigest ||
        observedImage === image.reference ||
        observedImage === image.localName ||
        observedImage.endsWith(`@${image.digest}`),
    )
  ) {
    throw new SandboxBackendError(
      "image_mismatch",
      "Container image does not match the admitted identity.",
    );
  }
}

function isIsolatedUidMap(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const mappings = value
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (mapping) =>
        mapping.length === 3 &&
        mapping.every((component) => Number.isSafeInteger(component)),
    );
  if (mappings.length === 0 || mappings[0]?.[0] !== 0) return false;
  return !mappings.some(
    (mapping) =>
      mapping[0] === 0 &&
      mapping[1] === 0 &&
      (mapping[2] ?? 0) >= 4_294_967_295,
  );
}

function hasNoProcessCapabilities(value: unknown): boolean {
  const capabilities = object(value);
  const expected = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
  return (
    Object.keys(capabilities).length === expected.length &&
    expected.every((name) => /^0+$/.test(String(capabilities[name] ?? "")))
  );
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
  private readonly profileAttestations = new Map<string, number>();
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
    this.profileAttestations.clear();
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
      stdin?: Uint8Array;
      maximumInputBytes?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ProcessResult> {
    return this.processes.run({
      executable: this.executable,
      arguments: arguments_,
      timeoutMs: options.timeoutMs ?? this.controlTimeoutMs,
      maximumOutputBytes:
        options.maximumOutputBytes ?? this.maximumControlOutputBytes,
      stdin: options.stdin,
      maximumInputBytes: options.maximumInputBytes,
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
    assertAdmittedImage(input.image);
    return this.executeAuthorized(input);
  }

  async executeRuntime(
    input: SandboxRuntimeExecution,
  ): Promise<SandboxExecutionResult> {
    assertAdmittedImage(input.image);
    return this.executeAuthorized({ ...input, command: input.image.runtime });
  }

  async executeInspectedImage(
    input: SandboxImageProbeExecution,
  ): Promise<SandboxExecutionResult> {
    assertInspectedImage(input.image);
    return this.executeAuthorized(input);
  }

  private async executeAuthorized(
    input: PreparedSandboxExecution,
  ): Promise<SandboxExecutionResult> {
    if (input.identity.runnerId !== this.options.runnerId) {
      throw new SandboxBackendError(
        "identity_mismatch",
        "Attempt runner does not own this backend.",
      );
    }
    if (input.source) {
      if (input.source.snapshot.digest !== input.source.expectedDigest) {
        throw new SandboxBackendError(
          "identity_mismatch",
          "Materialized source digest does not match the execution snapshot.",
        );
      }
      resolveMaterializedSourceSnapshot(
        input.source.snapshot,
        this.options.deploymentId,
        input.identity,
      );
    }
    if (input.request) {
      if (input.request.envelope.digest !== input.request.expectedDigest) {
        throw new SandboxBackendError(
          "identity_mismatch",
          "Materialized request digest does not match the execution request.",
        );
      }
      resolveMaterializedRuntimeRequest(
        input.request.envelope,
        this.options.deploymentId,
        input.identity,
      );
    }
    const readiness = await this.attest();
    if (readiness.architecture !== input.image.architecture) {
      throw new SandboxBackendError(
        "image_mismatch",
        "Admitted image architecture does not match the attested host.",
      );
    }
    await this.ensureProfileAttested(input.image, input.profile);
    return this.executePrepared(input);
  }

  private profileAttestationKey(
    image: SandboxImageAuthority,
    profile: SandboxResourceProfile,
  ): string {
    return `${image.digest}:${JSON.stringify(profile)}`;
  }

  private async ensureProfileAttested(
    image: SandboxImageAuthority,
    profile: SandboxResourceProfile,
  ): Promise<void> {
    const attestationKey = this.profileAttestationKey(image, profile);
    if ((this.profileAttestations.get(attestationKey) ?? 0) > this.now())
      return;

    const result = await this.executePrepared({
      identity: {
        runnerId: this.options.runnerId,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 1,
      },
      image,
      profile,
      command: image.profileProbe,
    });
    let proof: JsonObject;
    try {
      proof = object(JSON.parse(result.stdout) as unknown);
    } catch {
      this.invalidateReadiness();
      throw new SandboxBackendError(
        "engine",
        "AppArmor enforcement probe returned invalid JSON.",
      );
    }
    if (
      result.exitCode !== 0 ||
      proof["label"] !== "socrates-sandbox (enforce)" ||
      proof["denied"] !== true ||
      !isIsolatedUidMap(proof["uidMap"]) ||
      !hasNoProcessCapabilities(proof["capabilities"])
    ) {
      this.invalidateReadiness();
      throw new SandboxBackendError(
        "engine",
        "AppArmor enforcement probe did not prove the required label and denial.",
      );
    }
    this.profileAttestations.set(
      attestationKey,
      this.now() + this.readinessTtlMs,
    );
  }

  private async executePrepared(
    input: PreparedSandboxExecution,
  ): Promise<SandboxExecutionResult> {
    const key = sandboxAttemptKey(input.identity);
    if (this.active.has(key)) {
      throw new SandboxBackendError(
        "conflict",
        "This attempt already owns an active sandbox.",
      );
    }
    const ownership = createSandboxOwnership(
      this.options.deploymentId,
      input.identity,
    );
    const sourcePath = input.source
      ? resolveMaterializedSourceSnapshot(
          input.source.snapshot,
          this.options.deploymentId,
          input.identity,
        )
      : undefined;
    const requestPath = input.request
      ? resolveMaterializedRuntimeRequest(
          input.request.envelope,
          this.options.deploymentId,
          input.identity,
        )
      : undefined;
    if (
      input.request &&
      input.request.envelope.digest !== input.request.expectedDigest
    ) {
      throw new SandboxBackendError(
        "identity_mismatch",
        "Materialized request digest does not match the execution request.",
      );
    }
    let created = false;
    try {
      await this.requireSuccess(
        buildCreateArguments({
          ownership,
          image: input.image,
          profile: input.profile,
          command: input.command,
          source: input.source?.snapshot,
          request: input.request?.envelope,
          deploymentId: this.options.deploymentId,
          identity: input.identity,
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
      verifyNativeSpec(
        parseNativeSpec(native.stdout),
        input.profile,
        sourcePath,
        requestPath,
      );

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
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
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
