import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runnerExecutionV1Schema,
  type RunnerEventV2,
  type RunnerExecutionV1,
} from "@socrates/contracts";

import { runnerEventDraft, type RunnerEventDraft } from "../lifecycle/draft";
import { SpoolError } from "./contracts";
import { LocalEventSpool, systemSpoolIdentitySource } from "./store";

if (process.platform !== "linux") {
  throw new Error("Native spool validation requires Linux.");
}

const taskFixturePath = fileURLToPath(
  new URL(
    "../../../../packages/contracts/fixtures/runner/task-v2.json",
    import.meta.url,
  ),
);
const taskFixture = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(taskFixturePath, "utf8"),
  ),
) as unknown;
const runnerId = randomUUID();

function execution(attemptId: string): RunnerExecutionV1 {
  const task = taskFixture as { taskId?: unknown };
  return runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId,
      taskId: task.taskId,
      attemptId,
      fence: 1,
      leasedUntil: "2030-01-01T00:00:00.000Z",
    },
    task,
  });
}

function drafts(input: RunnerExecutionV1): readonly RunnerEventDraft[] {
  return Object.freeze([
    runnerEventDraft({
      type: "workspace.prepared",
      payload: {
        sourceDigest: input.task.source.digest,
        imageDigest: input.task.environment.imageDigest,
      },
    }),
    runnerEventDraft({
      type: "action.started",
      payload: { commandIndex: 0 },
    }),
    runnerEventDraft({
      type: "task.failed",
      payload: {
        classification: "infrastructure",
        message: "Native durability probe.",
      },
    }),
  ]);
}

function acknowledgement(event: RunnerEventV2) {
  return {
    version: "1" as const,
    eventId: event.eventId,
    attemptId: event.attemptId,
    acknowledgedSequence: event.sequence,
    expectedSequence: event.sequence + 1,
    receivedAt: "2026-07-31T12:00:01.000Z",
  };
}

function privateMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

const stateRoot = await mkdtemp(join(tmpdir(), "socrates-native-spool-"));
const limits = {
  maximumSegmentBytes: 1_000_000,
  maximumEventsPerSegment: 100,
  maximumAttempts: 10,
  maximumSpoolBytes: 10_000_000,
};

try {
  const primaryExecution = execution(randomUUID());
  const spool = await LocalEventSpool.open({
    rootPath: stateRoot,
    limits,
    identitySource: systemSpoolIdentitySource,
  });
  const events = await spool.append(primaryExecution, drafts(primaryExecution));
  const state = await spool.inspect(primaryExecution);
  const attemptRoot = join(stateRoot, "attempts", state.attemptKey);
  const segmentPath = join(
    attemptRoot,
    "segments",
    "0000000000000001-0000000000000003.json",
  );
  const [rootMetadata, attemptMetadata, segmentMetadata, commitMetadata] =
    await Promise.all([
      stat(stateRoot),
      stat(attemptRoot),
      stat(segmentPath),
      stat(join(attemptRoot, "commit.json")),
    ]);

  const restarted = await LocalEventSpool.open({
    rootPath: stateRoot,
    limits,
    identitySource: systemSpoolIdentitySource,
  });
  const replay = await restarted.pending(primaryExecution);
  if (JSON.stringify(replay) !== JSON.stringify(events)) {
    throw new Error("Native spool restart changed committed envelope bytes.");
  }
  for (const event of replay) {
    await restarted.acknowledge(primaryExecution, acknowledgement(event));
  }
  const terminalState = await restarted.inspect(primaryExecution);
  let segmentRemoved = false;
  try {
    await access(segmentPath);
  } catch {
    segmentRemoved = true;
  }
  if (
    !terminalState.terminal ||
    terminalState.pendingEvents !== 0 ||
    !segmentRemoved
  ) {
    throw new Error(
      "Native spool did not retain terminal acknowledgement state.",
    );
  }

  const corruptExecution = execution(randomUUID());
  const corruptEvents = await restarted.append(
    corruptExecution,
    drafts(corruptExecution),
  );
  const corruptState = await restarted.inspect(corruptExecution);
  await unlink(
    join(
      stateRoot,
      "attempts",
      corruptState.attemptKey,
      "segments",
      "0000000000000001-0000000000000003.json",
    ),
  );
  let missingSegmentRejected = false;
  try {
    await restarted.pending(corruptExecution);
  } catch (error) {
    missingSegmentRejected =
      error instanceof SpoolError && error.code === "corrupt";
  }
  if (!missingSegmentRejected || corruptEvents.length !== 3) {
    throw new Error("Native spool did not reject missing committed evidence.");
  }

  const evidence = {
    schema: "socrates.runner-spool.native.v1",
    recordedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    },
    gates: {
      directorySync: true,
      rootMode0700: privateMode(rootMetadata.mode, 0o700),
      attemptMode0700: privateMode(attemptMetadata.mode, 0o700),
      segmentMode0600: privateMode(segmentMetadata.mode, 0o600),
      commitMode0600: privateMode(commitMetadata.mode, 0o600),
      segmentSingleLink: segmentMetadata.nlink === 1,
      exactRestartReplay: true,
      monotonicAcknowledgement: terminalState.acknowledgedSequence === 3,
      terminalCleanup: segmentRemoved,
      missingSegmentRejected,
    },
  };
  if (Object.values(evidence.gates).some((passed) => !passed)) {
    throw new Error("One or more native spool gates failed.");
  }
  const evidenceDirectory = fileURLToPath(
    new URL("../../evidence/native/", import.meta.url),
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(
    evidenceDirectory,
    `${Date.now()}-${runnerId}-spool.json`,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`,
  );
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
