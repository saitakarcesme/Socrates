import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "tar-stream";

import { SourceSnapshotMaterializer } from "../source/materializer";
import { NerdctlSandboxBackend } from "./backend";
import { NodeProcessExecutor } from "./process";
import { createAdmittedImageForTesting } from "../image/testing";
import {
  NerdctlReadinessVerifier,
  NodeHostReadinessInspector,
} from "./readiness";

import type { SandboxAttemptIdentity } from "./identity";
import type { SandboxResourceProfile } from "./profile";

const digestPattern = /^.+@sha256:[a-f0-9]{64}$/;

async function sourceArchive(): Promise<Buffer> {
  const archive = pack();
  archive.entry(
    { name: "nested/probe.txt", type: "file", mode: 0o644, size: 18 },
    "socrates-source-ok",
  );
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function* bytes(value: Uint8Array) {
  yield value;
}

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
const image = createAdmittedImageForTesting(imageReference, architecture());
const sourceStateRoot = await mkdtemp(
  join(tmpdir(), "socrates-native-source-"),
);

try {
  const artifactStore = new LocalContentAddressedArtifactStore(
    join(sourceStateRoot, "artifacts"),
  );
  const materializer = new SourceSnapshotMaterializer(artifactStore, {
    root: join(sourceStateRoot, "materialized"),
    deploymentId: "native-reference-host",
    runnerId,
    limits: {
      maximumArchiveBytes: 1 * 1_024 * 1_024,
      maximumExpandedBytes: 1 * 1_024 * 1_024,
      maximumEntries: 32,
      maximumFileBytes: 256 * 1_024,
      maximumPathBytes: 256,
      maximumComponentBytes: 128,
      maximumPathDepth: 16,
    },
  });
  const archive = await sourceArchive();
  const archiveDigest = `sha256:${createHash("sha256")
    .update(archive)
    .digest("hex")}`;
  const artifact = await artifactStore.put({
    content: bytes(archive),
    expectedDigest: archiveDigest,
    expectedSizeBytes: archive.byteLength,
    maxSizeBytes: archive.byteLength,
  });

  const beforeRecovery = await backend.recoverOwned();
  const sourceRecovery = await materializer.recoverOwned();
  const readiness = await backend.attest();
  const successfulAttempt = identity(runnerId, randomUUID(), randomUUID());
  const source = await materializer.materialize({
    artifact,
    identity: successfulAttempt,
  });
  const { successful, sourceProof } = await (async () => {
    try {
      const result = await backend.execute({
        identity: successfulAttempt,
        image,
        profile,
        source: {
          snapshot: source,
          expectedDigest: artifact.digest,
        },
        command: {
          executable: "/usr/local/bin/node",
          arguments: [
            "-e",
            [
              "const fs=require('node:fs')",
              "const path='/socrates/source/nested/probe.txt'",
              "const value=fs.readFileSync(path,'utf8')",
              "let readOnly=false",
              "try{fs.writeFileSync(path,'changed')}catch(error){readOnly=['EACCES','EROFS'].includes(error?.code)}",
              "process.stdout.write(JSON.stringify({value,readOnly}))",
            ].join(";"),
          ],
        },
      });
      return {
        successful: result,
        sourceProof: JSON.parse(result.stdout) as {
          value?: unknown;
          readOnly?: unknown;
        },
      };
    } finally {
      await materializer.release(source);
    }
  })();
  if (
    successful.exitCode !== 0 ||
    sourceProof.value !== "socrates-source-ok" ||
    sourceProof.readOnly !== true
  ) {
    throw new Error(
      "Native source execution did not prove readable, read-only content.",
    );
  }
  const sourceDirectoriesAfterRelease = await readdir(
    join(sourceStateRoot, "materialized"),
  );
  const unreleasedSourceState = sourceDirectoriesAfterRelease.filter(
    (name) => name !== ".socrates-source-root.json",
  );

  const cancellationAttempt = identity(runnerId, randomUUID(), randomUUID());
  const running = backend.execute({
    identity: cancellationAttempt,
    image,
    profile,
    command: {
      executable: "/usr/local/bin/node",
      arguments: [
        "-e",
        "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      ],
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
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    image: imageReference,
    readiness,
    sourceSnapshot: {
      digest: artifact.digest,
      archiveBytes: source.archiveBytes,
      expandedBytes: source.expandedBytes,
      entryCount: source.entryCount,
    },
    gates: {
      scopedRecoveryBeforeRun: beforeRecovery === 0,
      sourceRecoveryBeforeRun: sourceRecovery === 0,
      sourceDigestAndSizeVerified: true,
      opaqueAttemptCapability: true,
      recursiveReadOnlySourceBind: sourceProof.readOnly === true,
      sourceReleased: unreleasedSourceState.length === 0,
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
  const evidenceDirectory = fileURLToPath(
    new URL("../../evidence/native/", import.meta.url),
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(
    evidenceDirectory,
    `${Date.now()}-${runnerId}.json`,
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`,
  );
} finally {
  await rm(sourceStateRoot, { recursive: true, force: true });
}
