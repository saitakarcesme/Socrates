import { createHash } from "node:crypto";

import {
  sandboxAttemptKey,
  type SandboxAttemptIdentity,
} from "../oci/identity";

declare const materializedSourceSnapshotBrand: unique symbol;

export type MaterializedSourceSnapshot = Readonly<{
  attemptKey: string;
  digest: string;
  archiveBytes: number;
  expandedBytes: number;
  entryCount: number;
  [materializedSourceSnapshotBrand]: true;
}>;

type MaterializedSnapshotRecord = {
  path: string;
  deployment: string;
  identity: SandboxAttemptIdentity;
  released: boolean;
};

const records = new WeakMap<
  MaterializedSourceSnapshot,
  MaterializedSnapshotRecord
>();

function deploymentKey(deploymentId: string): string {
  if (!deploymentId.trim()) {
    throw new TypeError("deploymentId cannot be empty.");
  }
  return createHash("sha256").update(deploymentId).digest("hex");
}

export function issueMaterializedSourceSnapshot(input: {
  path: string;
  deploymentId: string;
  identity: SandboxAttemptIdentity;
  digest: string;
  archiveBytes: number;
  expandedBytes: number;
  entryCount: number;
}): MaterializedSourceSnapshot {
  const capability = Object.freeze({
    attemptKey: sandboxAttemptKey(input.identity),
    digest: input.digest,
    archiveBytes: input.archiveBytes,
    expandedBytes: input.expandedBytes,
    entryCount: input.entryCount,
  }) as MaterializedSourceSnapshot;
  records.set(capability, {
    path: input.path,
    deployment: deploymentKey(input.deploymentId),
    identity: Object.freeze({ ...input.identity }),
    released: false,
  });
  return capability;
}

export function isMaterializedSourceSnapshot(
  value: MaterializedSourceSnapshot | undefined,
): value is MaterializedSourceSnapshot {
  const record = value ? records.get(value) : undefined;
  return record !== undefined && !record.released;
}

export function resolveMaterializedSourceSnapshot(
  capability: MaterializedSourceSnapshot,
  deploymentId: string,
  identity: SandboxAttemptIdentity,
): string {
  const record = records.get(capability);
  if (
    !record ||
    record.released ||
    record.deployment !== deploymentKey(deploymentId) ||
    sandboxAttemptKey(record.identity) !== sandboxAttemptKey(identity) ||
    capability.attemptKey !== sandboxAttemptKey(identity)
  ) {
    throw new TypeError(
      "Materialized source capability does not belong to this attempt.",
    );
  }
  return record.path;
}

export function prepareMaterializedSourceSnapshotRelease(
  capability: MaterializedSourceSnapshot,
  deploymentId: string,
  runnerId: string,
): string | undefined {
  const record = records.get(capability);
  if (
    !record ||
    record.released ||
    record.deployment !== deploymentKey(deploymentId) ||
    record.identity.runnerId !== runnerId
  ) {
    return undefined;
  }
  return record.path;
}

export function completeMaterializedSourceSnapshotRelease(
  capability: MaterializedSourceSnapshot,
): void {
  const record = records.get(capability);
  if (record) record.released = true;
}
