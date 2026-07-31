import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import {
  runtimeAbi,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "tar-stream";

import { SandboxImageCatalog } from "../image/catalog";
import { NerdctlImageHandshakeVerifier } from "../image/handshake";
import { NerdctlImageInspector } from "../image/inspection";
import { sandboxProfileProbe } from "../image/profile-probe";
import { NerdctlSandboxBackend } from "../oci/backend";
import { NodeProcessExecutor } from "../oci/process";
import {
  NerdctlReadinessVerifier,
  NodeHostReadinessInspector,
} from "../oci/readiness";
import { RuntimeSandboxExecutor } from "./executor";
import { SourceSnapshotMaterializer } from "../source/materializer";

import type { SandboxAttemptIdentity } from "../oci/identity";
import type { SandboxResourceProfile } from "../oci/profile";

type BuildIdentity = Readonly<{
  schema: "socrates.task-runtime.build.v1";
  abi: typeof runtimeAbi;
  runtimeBuildDigest: string;
  bundleDigest: string;
  entrypoint: Readonly<{
    executable: string;
    arguments: readonly string[];
  }>;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const imageReferencePattern = /^sha256:[a-f0-9]{64}$/u;

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

function identity(runnerId: string): SandboxAttemptIdentity {
  return {
    runnerId,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fence: 1,
  };
}

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

function buildRequest(input: {
  identity: SandboxAttemptIdentity;
  sourceDigest: string;
  actionSource: string;
  wallTimeMs?: number;
}): RuntimeRequest {
  return runtimeRequestSchema.parse({
    schema: "socrates.task-runtime.request.v1",
    identity: input.identity,
    source: { digest: input.sourceDigest, path: "/socrates/source" },
    actions: [
      {
        executable: "/usr/local/bin/node",
        arguments: ["-e", input.actionSource],
        workingDirectory: "/workspace",
        timeoutMs: input.wallTimeMs ?? 5_000,
      },
    ],
    measurement: {
      metricDefinitionId: randomUUID(),
      protocolRevision: 1,
      unit: "score",
      command: {
        executable: "/usr/local/bin/node",
        arguments: [
          "-e",
          [
            "const fs=require('node:fs')",
            "const source=fs.readFileSync('nested/probe.txt','utf8')",
            "const result=fs.readFileSync('nested/result.txt','utf8')",
            "process.stdout.write(JSON.stringify({schema:'metric-value.v1',value:'1',source,result}))",
          ].join(";"),
        ],
        workingDirectory: "/workspace",
        timeoutMs: 5_000,
      },
      maximumResultBytes: 4_096,
    },
    budget: {
      wallTimeMs: input.wallTimeMs ?? 10_000,
      writableBytes: 1 * 1_024 * 1_024,
      outputBytes: 256 * 1_024,
      commandCount: 2,
    },
  });
}

function decodeFrameBytes(
  frames: readonly RuntimeFrame[],
  predicate: (frame: RuntimeFrame) => boolean,
): Buffer {
  return Buffer.concat(
    frames
      .filter(predicate)
      .map((frame) =>
        "bytes" in frame ? Buffer.from(frame.bytes, "base64") : Buffer.alloc(0),
      ),
  );
}

const imageReference = argument("--image");
if (!imageReferencePattern.test(imageReference)) {
  throw new Error("--image must be a bare SHA-256 manifest content address.");
}
const buildManifestPath = fileURLToPath(
  new URL("../../../task-runtime/dist/build-identity.json", import.meta.url),
);
const buildIdentity = JSON.parse(
  await readFile(buildManifestPath, "utf8"),
) as BuildIdentity;
if (
  buildIdentity.schema !== "socrates.task-runtime.build.v1" ||
  buildIdentity.abi !== runtimeAbi ||
  !digestPattern.test(buildIdentity.runtimeBuildDigest) ||
  !digestPattern.test(buildIdentity.bundleDigest) ||
  buildIdentity.entrypoint.executable !== "/usr/local/bin/node" ||
  buildIdentity.entrypoint.arguments.length !== 1
) {
  throw new Error("Task runtime build identity is invalid.");
}

const runnerId = randomUUID();
const profile: SandboxResourceProfile = {
  memoryBytes: 128 * 1_024 * 1_024,
  cpuCount: 0.5,
  maximumPids: 32,
  workspaceBytes: 2 * 1_024 * 1_024,
  temporaryBytes: 1 * 1_024 * 1_024,
  sharedMemoryBytes: 64 * 1_024,
};
const processes = new NodeProcessExecutor();
const backend = new NerdctlSandboxBackend(
  processes,
  new NerdctlReadinessVerifier(processes, new NodeHostReadinessInspector()),
  {
    deploymentId: "native-task-runtime",
    runnerId,
    executionTimeoutMs: 20_000,
    maximumControlOutputBytes: 1 * 1_024 * 1_024,
    maximumExecutionOutputBytes: 1 * 1_024 * 1_024,
  },
);
const inspector = new NerdctlImageInspector(processes);
const architectureName = architecture();
const pipelineInspection = await inspector.inspect({
  reference: imageReference,
  architecture: architectureName,
});
const catalog = new SandboxImageCatalog(
  [
    {
      reference: imageReference,
      manifestDigest: pipelineInspection.manifestDigest,
      manifestMediaType: pipelineInspection.manifestMediaType,
      configurationDigest: pipelineInspection.configurationDigest,
      architecture: architectureName,
      runtimeBuildDigest: buildIdentity.runtimeBuildDigest,
      runtimeBundleDigest: buildIdentity.bundleDigest,
      runtime: buildIdentity.entrypoint,
      profileProbe: sandboxProfileProbe,
      environment: pipelineInspection.environment,
    },
  ],
  inspector,
  new NerdctlImageHandshakeVerifier(backend, { runnerId, profile }),
);
const image = await catalog.admit(
  pipelineInspection.manifestDigest,
  architectureName,
);
const runtime = new RuntimeSandboxExecutor(backend, {
  maximumProtocolBytes: 1 * 1_024 * 1_024,
  maximumChildOutputBytes: 256 * 1_024,
});
const sourceStateRoot = await mkdtemp(
  join(tmpdir(), "socrates-runtime-native-"),
);

try {
  const artifactStore = new LocalContentAddressedArtifactStore(
    join(sourceStateRoot, "artifacts"),
  );
  const materializer = new SourceSnapshotMaterializer(artifactStore, {
    root: join(sourceStateRoot, "materialized"),
    deploymentId: "native-task-runtime",
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
  const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const artifact = await artifactStore.put({
    content: bytes(archive),
    expectedDigest: archiveDigest,
    expectedSizeBytes: archive.byteLength,
    maxSizeBytes: archive.byteLength,
  });
  const recoveryBefore = await backend.recoverOwned();
  const sourceRecoveryBefore = await materializer.recoverOwned();

  const successfulIdentity = identity(runnerId);
  const successfulSource = await materializer.materialize({
    artifact,
    identity: successfulIdentity,
  });
  const actionSource = [
    "const fs=require('node:fs')",
    "const source=fs.readFileSync('/workspace/nested/probe.txt','utf8')",
    "fs.writeFileSync('/workspace/nested/result.txt','workspace-write-ok')",
    "let readOnly=false",
    "try{fs.writeFileSync('/socrates/source/nested/probe.txt','changed')}catch(error){readOnly=['EACCES','EROFS'].includes(error?.code)}",
    "process.stdout.write(JSON.stringify({source,readOnly}))",
  ].join(";");
  let successful;
  try {
    successful = await runtime.execute({
      request: buildRequest({
        identity: successfulIdentity,
        sourceDigest: artifact.digest,
        actionSource,
      }),
      image,
      profile,
      source: successfulSource,
    });
  } finally {
    await materializer.release(successfulSource);
  }
  const actionProof = JSON.parse(
    decodeFrameBytes(
      successful.frames,
      (frame) =>
        frame.type === "command.output" &&
        frame.phase === "action" &&
        frame.stream === "stdout",
    ).toString("utf8"),
  ) as { source?: unknown; readOnly?: unknown };
  const measurementProof = JSON.parse(
    decodeFrameBytes(
      successful.frames,
      (frame) => frame.type === "measurement.result",
    ).toString("utf8"),
  ) as { source?: unknown; result?: unknown; value?: unknown };
  if (
    successful.status !== "succeeded" ||
    actionProof.source !== "socrates-source-ok" ||
    actionProof.readOnly !== true ||
    measurementProof.source !== "socrates-source-ok" ||
    measurementProof.result !== "workspace-write-ok" ||
    measurementProof.value !== "1"
  ) {
    throw new Error("Native runtime action or measurement proof is invalid.");
  }

  const cancellationIdentity = identity(runnerId);
  const cancellationSource = await materializer.materialize({
    artifact,
    identity: cancellationIdentity,
  });
  const cancellationRun = runtime
    .execute({
      request: buildRequest({
        identity: cancellationIdentity,
        sourceDigest: artifact.digest,
        actionSource: "setInterval(()=>{},1000)",
        wallTimeMs: 15_000,
      }),
      image,
      profile,
      source: cancellationSource,
    })
    .then(() => undefined)
    .catch((error: unknown) => error);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const cancellationAccepted = await backend.cancel(
    cancellationIdentity,
    1_000,
  );
  const cancellationOutcome = await cancellationRun;
  await materializer.release(cancellationSource);
  if (!cancellationAccepted || !(cancellationOutcome instanceof Error)) {
    throw new Error("Native runtime cancellation did not interrupt execution.");
  }

  const recoveryAfter = await backend.recoverOwned();
  const sourceDirectories = await readdir(
    join(sourceStateRoot, "materialized"),
  );
  const unreleasedSources = sourceDirectories.filter(
    (name) => name !== ".socrates-source-root.json",
  );
  if (recoveryAfter !== 0 || unreleasedSources.length !== 0) {
    throw new Error("Native runtime validation left owned state behind.");
  }

  const evidence = {
    schemaVersion: 3,
    recordedAt: new Date().toISOString(),
    image: {
      reference: image.reference,
      manifestDigest: pipelineInspection.manifestDigest,
      configurationDigest: pipelineInspection.configurationDigest,
      mediaType: pipelineInspection.manifestMediaType,
      architecture: architectureName,
      runtimeBuildDigest: buildIdentity.runtimeBuildDigest,
      runtimeBundleDigest: buildIdentity.bundleDigest,
    },
    gates: {
      pipelineIssuedCatalogIdentity: true,
      localPullFreeInspection: true,
      opaqueInspectedCapability: true,
      guardedLiveHandshake: true,
      opaqueAdmittedCapability: true,
      canonicalBoundedStdin: true,
      exactRuntimeEntrypoint: true,
      sourceCopiedToWorkspace: actionProof.source === "socrates-source-ok",
      recursiveReadOnlySourceBind: actionProof.readOnly === true,
      workspaceWrite: measurementProof.result === "workspace-write-ok",
      framedMeasurement: measurementProof.value === "1",
      exactFenceCancellation: cancellationAccepted,
      sourceReleased: unreleasedSources.length === 0,
      cleanup: recoveryAfter === 0,
      scopedRecoveryBeforeRun: recoveryBefore === 0,
      sourceRecoveryBeforeRun: sourceRecoveryBefore === 0,
    },
    successfulExecution: {
      status: successful.status,
      durationMs: successful.durationMs,
      frameCount: successful.frames.length,
    },
    cancellation: {
      accepted: cancellationAccepted,
      error: cancellationOutcome.name,
    },
  };
  const evidenceDirectory = fileURLToPath(
    new URL("../../evidence/native/", import.meta.url),
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(
    evidenceDirectory,
    `${Date.now()}-${runnerId}-runtime.json`,
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
