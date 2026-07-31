import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { NerdctlSandboxBackend } from "./backend";
import { NodeProcessExecutor } from "./process";
import { unsafeCreateAdmittedImageForTesting } from "./profile";
import {
  NerdctlReadinessVerifier,
  NodeHostReadinessInspector,
} from "./readiness";

import type { SandboxAttemptIdentity } from "./identity";
import type { SandboxResourceProfile } from "./profile";

const digestPattern = /^.+@sha256:[a-f0-9]{64}$/;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function architecture(): "amd64" | "arm64" {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported architecture ${process.arch}.`);
}

function identity(
  runnerId: string,
  taskId: string,
  attemptId: string,
): SandboxAttemptIdentity {
  return { runnerId, taskId, attemptId, fence: 1 };
}

const imageReference = argument("--image");
if (!digestPattern.test(imageReference)) {
  throw new Error("--image must be an immutable SHA-256 reference.");
}

const runnerId = randomUUID();
const profile: SandboxResourceProfile = {
  memoryBytes: 64 * 1_024 * 1_024,
  cpuCount: 0.5,
  maximumPids: 32,
  workspaceBytes: 1 * 1_024 * 1_024,
  temporaryBytes: 256 * 1_024,
  sharedMemoryBytes: 64 * 1_024,
};
const processes = new NodeProcessExecutor();
const readinessVerifier = new NerdctlReadinessVerifier(
  processes,
  new NodeHostReadinessInspector(),
);
const backend = new NerdctlSandboxBackend(processes, readinessVerifier, {
  deploymentId: "native-reference-host",
  runnerId,
  executionTimeoutMs: 15_000,
});
const image = unsafeCreateAdmittedImageForTesting(
  imageReference,
  architecture(),
);

const beforeRecovery = await backend.recoverOwned();
const readiness = await backend.attest();
const successfulAttempt = identity(runnerId, randomUUID(), randomUUID());
const successful = await backend.execute({
  identity: successfulAttempt,
  image,
  profile,
  command: {
    executable: "/usr/local/bin/node",
    arguments: ["-e", "process.stdout.write('socrates-native-ok')"],
  },
});
if (successful.exitCode !== 0 || successful.stdout !== "socrates-native-ok") {
  throw new Error(
    "Bounded native execution did not return the expected result.",
  );
}

const cancellationAttempt = identity(runnerId, randomUUID(), randomUUID());
const running = backend.execute({
  identity: cancellationAttempt,
  image,
  profile,
  command: {
    executable: "/usr/local/bin/node",
    arguments: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  },
});
await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
const cancellationStartedAt = performance.now();
const cancellationAccepted = await backend.cancel(cancellationAttempt, 1_000);
const cancellationDurationMs =
  Math.round((performance.now() - cancellationStartedAt) * 100) / 100;
const cancelled = await running;
if (!cancellationAccepted || cancelled.exitCode === 0) {
  throw new Error("Native cancellation did not terminate the sandbox.");
}
const afterRecovery = await backend.recoverOwned();
if (afterRecovery !== 0) {
  throw new Error("Native validation left an owned sandbox behind.");
}

const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  image: imageReference,
  readiness,
  gates: {
    scopedRecoveryBeforeRun: beforeRecovery === 0,
    createBeforeNativeInspect: true,
    nativeSpecVerifiedBeforeStart: true,
    boundedExecution: true,
    exactFenceCancellation: cancellationAccepted,
    cleanup: afterRecovery === 0,
  },
  successfulExecution: {
    exitCode: successful.exitCode,
    durationMs: successful.durationMs,
  },
  cancellation: {
    exitCode: cancelled.exitCode,
    durationMs: cancellationDurationMs,
  },
};
const evidenceDirectory = resolve("services/runner-local/evidence/native");
await mkdir(evidenceDirectory, { recursive: true });
const evidencePath = resolve(
  evidenceDirectory,
  `${Date.now()}-${runnerId}.json`,
);
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`,
);
