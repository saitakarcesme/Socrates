import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runnerExecutionV1Schema } from "@socrates/contracts";

import type { RunnerControlPlaneClient } from "../transport/client";
import { deliveryKeyFor } from "./codec";
import { ExactClaimReconciler } from "./reconciler";
import { LocalWorkJournal } from "./store";

if (process.platform !== "linux")
  throw new Error("Native work journal validation requires Linux.");

const fixturePath = fileURLToPath(
  new URL(
    "../../../../packages/contracts/fixtures/runner/task-v2.json",
    import.meta.url,
  ),
);
const task = JSON.parse(await readFile(fixturePath, "utf8")) as {
  taskId: string;
};
const delivery = {
  version: "1" as const,
  deliveryId: randomUUID(),
  taskId: task.taskId,
};
const rejectedDelivery = {
  version: "1" as const,
  deliveryId: randomUUID(),
  taskId: task.taskId,
};
const attemptId = randomUUID();
const runnerId = randomUUID();
const rootPath = await mkdtemp(join(tmpdir(), "socrates-native-journal-"));
const limits = {
  maximumManifestBytes: 10_000,
  maximumClaimBytes: 1_000_000,
  maximumItems: 10,
  maximumJournalBytes: 10_000_000,
};
const identitySource = {
  attemptId: () => attemptId,
  now: () => new Date("2026-07-31T12:00:00.000Z"),
};

try {
  const journal = await LocalWorkJournal.open({
    rootPath,
    limits,
    identitySource,
  });
  await journal.admit(delivery);
  const execution = runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId,
      taskId: delivery.taskId,
      attemptId,
      fence: 1,
      leasedUntil: "2030-01-01T00:00:00.000Z",
    },
    task,
  });
  let calls = 0;
  const client = {
    claimTaskDelivery: async () => {
      calls += 1;
      return execution;
    },
  } as unknown as RunnerControlPlaneClient;
  await new ExactClaimReconciler({
    journal,
    client,
    leaseDurationMs: 60_000,
  }).reconcile(delivery);
  await journal.commitCompletion(delivery.deliveryId, execution, {
    attemptKey: "a".repeat(64),
    acknowledgedSequence: 1,
  });
  await journal.admit(rejectedDelivery);
  await journal.commitRejection(rejectedDelivery.deliveryId, {
    status: 409,
    apiCode: "resource_conflict",
    requestId: "native-rejection-proof",
  });

  const restarted = await LocalWorkJournal.open({
    rootPath,
    limits,
    identitySource,
  });
  const replay = await new ExactClaimReconciler({
    journal: restarted,
    client,
    leaseDurationMs: 60_000,
  }).reconcile(delivery);
  const itemPath = join(rootPath, "work", deliveryKeyFor(delivery));
  const rejectedItemPath = join(
    rootPath,
    "work",
    deliveryKeyFor(rejectedDelivery),
  );
  const rejectedState = await restarted.inspect(rejectedDelivery.deliveryId);
  const completedState = await restarted.inspect(delivery.deliveryId);
  const [
    rootMetadata,
    workMetadata,
    itemMetadata,
    manifestMetadata,
    claimMetadata,
    rejectionMetadata,
    completionMetadata,
  ] = await Promise.all([
    stat(rootPath),
    stat(join(rootPath, "work")),
    stat(itemPath),
    stat(join(itemPath, "manifest.json")),
    stat(join(itemPath, "claim.json")),
    stat(join(rejectedItemPath, "rejection.json")),
    stat(join(itemPath, "completion.json")),
  ]);
  const privateMode = (mode: number, expected: number) =>
    (mode & 0o777) === expected;
  const evidence = {
    schema: "socrates.runner-work-journal.native.v3",
    recordedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    gates: {
      rootMode0700: privateMode(rootMetadata.mode, 0o700),
      workMode0700: privateMode(workMetadata.mode, 0o700),
      itemMode0700: privateMode(itemMetadata.mode, 0o700),
      manifestMode0600: privateMode(manifestMetadata.mode, 0o600),
      claimMode0600: privateMode(claimMetadata.mode, 0o600),
      rejectionMode0600: privateMode(rejectionMetadata.mode, 0o600),
      completionMode0600: privateMode(completionMetadata.mode, 0o600),
      manifestSingleLink: manifestMetadata.nlink === 1,
      claimSingleLink: claimMetadata.nlink === 1,
      rejectionSingleLink: rejectionMetadata.nlink === 1,
      completionSingleLink: completionMetadata.nlink === 1,
      exactAttemptReplay: replay.lease.attemptId === attemptId,
      noNetworkAfterCommit: calls === 1,
      rejectedAfterRestart:
        rejectedState?.state === "rejected" &&
        rejectedState.rejection?.apiCode === "resource_conflict",
      completedAfterRestart:
        completedState?.state === "completed" &&
        completedState.completion?.acknowledgedSequence === 1,
    },
  };
  if (Object.values(evidence.gates).some((passed) => !passed))
    throw new Error("One or more native work journal gates failed.");
  const evidenceDirectory = fileURLToPath(
    new URL("../../evidence/native/", import.meta.url),
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(
    evidenceDirectory,
    `${Date.now()}-${runnerId}-journal.json`,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ evidencePath, ...evidence }, null, 2)}\n`,
  );
} finally {
  await rm(rootPath, { recursive: true, force: true });
}
