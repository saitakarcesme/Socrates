import { createHash } from "node:crypto";

import {
  sandboxAttemptKey,
  type SandboxAttemptIdentity,
} from "../oci/identity";

declare const materializedRuntimeRequestBrand: unique symbol;

export type MaterializedRuntimeRequest = Readonly<{
  attemptKey: string;
  digest: string;
  sizeBytes: number;
  [materializedRuntimeRequestBrand]: true;
}>;

type RequestRecord = {
  path: string;
  deployment: string;
  identity: SandboxAttemptIdentity;
  released: boolean;
};

const records = new WeakMap<MaterializedRuntimeRequest, RequestRecord>();

function deploymentKey(value: string): string {
  if (!value.trim()) throw new TypeError("deploymentId cannot be empty.");
  return createHash("sha256").update(value).digest("hex");
}

export function issueMaterializedRuntimeRequest(input: {
  path: string;
  deploymentId: string;
  identity: SandboxAttemptIdentity;
  digest: string;
  sizeBytes: number;
}): MaterializedRuntimeRequest {
  const capability = Object.freeze({
    attemptKey: sandboxAttemptKey(input.identity),
    digest: input.digest,
    sizeBytes: input.sizeBytes,
  }) as MaterializedRuntimeRequest;
  records.set(capability, {
    path: input.path,
    deployment: deploymentKey(input.deploymentId),
    identity: Object.freeze({ ...input.identity }),
    released: false,
  });
  return capability;
}

export function resolveMaterializedRuntimeRequest(
  capability: MaterializedRuntimeRequest,
  deploymentId: string,
  identity: SandboxAttemptIdentity,
): string {
  const record = records.get(capability);
  if (
    !record ||
    record.released ||
    record.deployment !== deploymentKey(deploymentId) ||
    record.identity.runnerId !== identity.runnerId ||
    record.identity.taskId !== identity.taskId ||
    record.identity.attemptId !== identity.attemptId ||
    record.identity.fence !== identity.fence ||
    capability.attemptKey !== sandboxAttemptKey(identity)
  ) {
    throw new TypeError(
      "Materialized request capability does not belong to this attempt.",
    );
  }
  return record.path;
}

export function prepareMaterializedRuntimeRequestRelease(
  capability: MaterializedRuntimeRequest,
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

export function completeMaterializedRuntimeRequestRelease(
  capability: MaterializedRuntimeRequest,
): void {
  const record = records.get(capability);
  if (record) record.released = true;
}
