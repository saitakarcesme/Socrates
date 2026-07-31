import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { issueMaterializedSourceSnapshot } from "../source/capability";
import { resolveMaterializedRuntimeRequest } from "./capability";
import { RuntimeRequestMaterializer } from "./materializer";

const deploymentId = "request-test";
const identity = {
  runnerId: "10000000-0000-4000-8000-000000000001",
  taskId: "20000000-0000-4000-8000-000000000002",
  attemptId: "30000000-0000-4000-8000-000000000003",
  fence: 4,
} as const;
const roots: string[] = [];

async function fixture(maximumBytes = 1_024) {
  const root = await mkdtemp(join(tmpdir(), "socrates-request-"));
  roots.push(root);
  const tree = join(root, "source-owned", "tree");
  await mkdir(tree, { recursive: true });
  const source = issueMaterializedSourceSnapshot({
    path: tree,
    deploymentId,
    identity,
    digest: `sha256:${"a".repeat(64)}`,
    archiveBytes: 1_024,
    expandedBytes: 1,
    entryCount: 1,
  });
  return {
    source,
    materializer: new RuntimeRequestMaterializer({
      deploymentId,
      runnerId: identity.runnerId,
      maximumBytes,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RuntimeRequestMaterializer", () => {
  it("publishes and releases an attempt-scoped immutable request", async () => {
    const { source, materializer } = await fixture();
    const bytes = Uint8Array.from([0, 0, 0, 2, 123, 125]);
    const request = await materializer.materialize({ bytes, identity, source });
    const path = resolveMaterializedRuntimeRequest(
      request,
      deploymentId,
      identity,
    );

    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    expect(request.digest).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );

    await materializer.release(request);
    expect(() =>
      resolveMaterializedRuntimeRequest(request, deploymentId, identity),
    ).toThrow(/does not belong/u);
  });

  it("rejects oversized bytes and cross-runner attempts", async () => {
    const { source, materializer } = await fixture(2);
    await expect(
      materializer.materialize({
        bytes: Uint8Array.from([1, 2, 3]),
        identity,
        source,
      }),
    ).rejects.toThrow(/limit/u);
    await expect(
      materializer.materialize({
        bytes: Uint8Array.from([1]),
        identity: {
          ...identity,
          runnerId: "40000000-0000-4000-8000-000000000004",
        },
        source,
      }),
    ).rejects.toThrow(/runner/u);
  });
});
