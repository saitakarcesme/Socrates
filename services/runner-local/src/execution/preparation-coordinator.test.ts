import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import { runnerExecutionV1Schema } from "@socrates/contracts";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issueAdmittedSandboxImage } from "../image/capability";
import { issueMaterializedSourceSnapshot } from "../source/capability";
import {
  AttemptPreparationCoordinator,
  AttemptPreparationError,
  type ExecutionImageAdmissionPort,
  type ExecutionSourceArtifactResolver,
  type ExecutionSourceMaterializerPort,
  type PreparedExecutionAttempt,
} from "./preparation-coordinator";
import { ExecutionPlanProjector, type LocalExecutionPolicy } from "./projector";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const roots: string[] = [];
const mebibyte = 1_024 * 1_024;
const policy: LocalExecutionPolicy = {
  maximumWallTimeMs: 300_000,
  maximumMemoryBytes: 1_024 * mebibyte,
  maximumPids: 128,
  maximumWritableBytes: 1_024 * mebibyte,
  maximumRuntimeOutputBytes: 2 * mebibyte,
  maximumCommandCount: 3,
  temporaryBytes: 64 * mebibyte,
  sharedMemoryBytes: 64 * mebibyte,
  cpuQuotaPeriodMicros: 100_000,
  minimumCpuQuotaMicros: 1_000,
  maximumCpuQuotaMicros: 100_000,
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness(content = "owned source artifact") {
  const root = await mkdtemp(join(tmpdir(), "socrates-preparation-"));
  roots.push(root);
  const bytes = new TextEncoder().encode(content);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const store = new LocalContentAddressedArtifactStore(join(root, "artifacts"));
  const artifact = await store.put({
    content: (async function* () {
      yield bytes;
    })(),
    expectedDigest: digest,
    expectedSizeBytes: bytes.byteLength,
    maxSizeBytes: bytes.byteLength,
  });
  const execution = runnerExecutionV1Schema.parse({
    version: "1",
    lease: {
      version: "1",
      runnerId: "10000000-0000-4000-8000-000000000001",
      taskId: taskFixture.taskId,
      attemptId: "20000000-0000-4000-8000-000000000002",
      fence: 3,
      leasedUntil: "2026-07-31T18:00:00.000Z",
    },
    task: { ...taskFixture, source: { ...taskFixture.source, digest } },
  });
  const image = issueAdmittedSandboxImage({
    reference: execution.task.environment.imageDigest,
    localName: "trusted@digest",
    digest: execution.task.environment.imageDigest,
    configurationDigest:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    architecture: execution.task.environment.architecture,
    runtime: { executable: "/runtime", arguments: [] },
    profileProbe: { executable: "/probe", arguments: [] },
  });
  const order: string[] = [];
  const artifacts: ExecutionSourceArtifactResolver = {
    resolve: vi.fn(async () => {
      order.push("artifact");
      return artifact;
    }),
  };
  const images: ExecutionImageAdmissionPort = {
    admit: vi.fn(async () => {
      order.push("image");
      return image;
    }),
  };
  const sources: ExecutionSourceMaterializerPort = {
    materialize: vi.fn(async (input) => {
      order.push("source");
      return issueMaterializedSourceSnapshot({
        path: join(root, "source"),
        deploymentId: "test",
        identity: input.identity,
        digest: input.artifact.digest,
        archiveBytes: input.artifact.sizeBytes,
        expandedBytes: 1,
        entryCount: 1,
      });
    }),
    release: vi.fn(async () => undefined),
  };
  const coordinator = new AttemptPreparationCoordinator({
    execution,
    projector: new ExecutionPlanProjector(policy),
    artifacts,
    images,
    sources,
  });
  return {
    artifact,
    artifacts,
    coordinator,
    execution,
    image,
    images,
    order,
    root,
    sources,
  };
}

describe("AttemptPreparationCoordinator", () => {
  it("prepares exact immutable capabilities in the declared order", async () => {
    const value = await harness();
    const controller = new AbortController();
    const prepared = await value.coordinator.prepare(controller.signal);

    expect(value.order).toEqual(["artifact", "image", "source"]);
    expect(value.artifacts.resolve).toHaveBeenCalledWith({
      snapshotId: value.execution.task.source.snapshotId,
      digest: value.execution.task.source.digest,
      signal: controller.signal,
    });
    expect(value.images.admit).toHaveBeenCalledWith(
      value.execution.task.environment.imageDigest,
      value.execution.task.environment.architecture,
    );
    expect(value.sources.materialize).toHaveBeenCalledWith({
      artifact: value.artifact,
      identity: prepared.identity,
      signal: controller.signal,
    });
    expect(prepared.plan.request.identity).toEqual(prepared.identity);
    expect(prepared.image).toBe(value.image);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.identity)).toBe(true);
  });

  it("rejects projection before any I/O", async () => {
    const value = await harness();
    const coordinator = new AttemptPreparationCoordinator({
      execution: value.execution,
      projector: new ExecutionPlanProjector({
        ...policy,
        maximumWallTimeMs: value.execution.task.budget.wallTimeMs - 1,
      }),
      artifacts: value.artifacts,
      images: value.images,
      sources: value.sources,
    });

    await expect(coordinator.prepare()).rejects.toMatchObject({
      code: "policy_exceeded",
    });
    expect(value.order).toEqual([]);
  });

  it("rejects pre-aborted preparation before any I/O", async () => {
    const value = await harness();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(value.coordinator.prepare(controller.signal)).rejects.toEqual(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(value.order).toEqual([]);
  });

  it("fails closed for unavailable and forged artifacts", async () => {
    const unavailable = await harness();
    vi.mocked(unavailable.artifacts.resolve).mockResolvedValueOnce(undefined);
    await expect(unavailable.coordinator.prepare()).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect(unavailable.images.admit).not.toHaveBeenCalled();

    const forged = await harness();
    vi.mocked(forged.artifacts.resolve).mockResolvedValueOnce({
      digest: forged.execution.task.source.digest,
      sizeBytes: 10,
    });
    await expect(forged.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    expect(forged.images.admit).not.toHaveBeenCalled();

    const drifted = await harness();
    const other = await harness("different source artifact");
    vi.mocked(drifted.artifacts.resolve).mockResolvedValueOnce(other.artifact);
    await expect(drifted.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_artifact",
    });
  });

  it("propagates port failures without invoking later or unowned cleanup", async () => {
    const resolverFailure = await harness();
    vi.mocked(resolverFailure.artifacts.resolve).mockRejectedValueOnce(
      new Error("resolver unavailable"),
    );
    await expect(resolverFailure.coordinator.prepare()).rejects.toThrow(
      "resolver unavailable",
    );
    expect(resolverFailure.images.admit).not.toHaveBeenCalled();

    const imageFailure = await harness();
    vi.mocked(imageFailure.images.admit).mockRejectedValueOnce(
      new Error("image unavailable"),
    );
    await expect(imageFailure.coordinator.prepare()).rejects.toThrow(
      "image unavailable",
    );
    expect(imageFailure.sources.materialize).not.toHaveBeenCalled();

    const sourceFailure = await harness();
    vi.mocked(sourceFailure.sources.materialize).mockRejectedValueOnce(
      new Error("source unavailable"),
    );
    await expect(sourceFailure.coordinator.prepare()).rejects.toThrow(
      "source unavailable",
    );
    expect(sourceFailure.sources.release).not.toHaveBeenCalled();
  });

  it("fails closed for forged or identity-drifted image capabilities", async () => {
    const forged = await harness();
    vi.mocked(forged.images.admit).mockResolvedValueOnce({
      ...forged.image,
    });
    await expect(forged.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_image",
    });
    expect(forged.sources.materialize).not.toHaveBeenCalled();

    const drifted = await harness();
    const wrong = issueAdmittedSandboxImage({
      ...drifted.image,
      reference:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      digest:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    vi.mocked(drifted.images.admit).mockResolvedValueOnce(wrong);
    await expect(drifted.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_image",
    });
  });

  it("compensates an invalid materialized source", async () => {
    const value = await harness();
    const wrong = issueMaterializedSourceSnapshot({
      path: join(value.root, "wrong"),
      deploymentId: "test",
      identity: {
        runnerId: value.execution.lease.runnerId,
        taskId: value.execution.lease.taskId,
        attemptId: value.execution.lease.attemptId,
        fence: value.execution.lease.fence + 1,
      },
      digest: value.execution.task.source.digest,
      archiveBytes: value.artifact.sizeBytes,
      expandedBytes: 1,
      entryCount: 1,
    });
    vi.mocked(value.sources.materialize).mockResolvedValueOnce(wrong);

    await expect(value.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_source",
    });
    expect(value.sources.release).toHaveBeenCalledOnce();
    expect(value.sources.release).toHaveBeenCalledWith(wrong);
  });

  it("compensates cancellation immediately after source issuance", async () => {
    const value = await harness();
    const controller = new AbortController();
    const original = vi
      .mocked(value.sources.materialize)
      .getMockImplementation();
    vi.mocked(value.sources.materialize).mockImplementationOnce(
      async (input) => {
        const source = await original!(input);
        controller.abort(new Error("lease lost"));
        return source;
      },
    );

    await expect(
      value.coordinator.prepare(controller.signal),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(value.sources.release).toHaveBeenCalledOnce();
  });

  it("normalizes cancellation observed while an awaited port rejects", async () => {
    const value = await harness();
    const controller = new AbortController();
    vi.mocked(value.artifacts.resolve).mockImplementationOnce(async () => {
      controller.abort(new Error("lease lost"));
      throw new Error("resolver interrupted");
    });

    await expect(
      value.coordinator.prepare(controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(value.images.admit).not.toHaveBeenCalled();
  });

  it("surfaces compensation uncertainty with both causes", async () => {
    const value = await harness();
    vi.mocked(value.sources.materialize).mockImplementationOnce(async (input) =>
      issueMaterializedSourceSnapshot({
        path: join(value.root, "wrong-digest"),
        deploymentId: "test",
        identity: input.identity,
        digest:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        archiveBytes: 1,
        expandedBytes: 1,
        entryCount: 1,
      }),
    );
    vi.mocked(value.sources.release).mockRejectedValueOnce(
      new Error("disk unavailable"),
    );

    const error = await value.coordinator
      .prepare()
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "cleanup_failed" });
    expect((error as AttemptPreparationError).cause).toBeInstanceOf(
      AggregateError,
    );
    expect(
      ((error as AttemptPreparationError).cause as AggregateError).errors,
    ).toHaveLength(2);
  });

  it("shares one authoritative preparation promise and ignores later signals", async () => {
    const value = await harness();
    const first = new AbortController();
    const later = new AbortController();
    const left = value.coordinator.prepare(first.signal);
    const right = value.coordinator.prepare(later.signal);
    later.abort(new Error("not authoritative"));

    expect(right).toBe(left);
    await expect(left).resolves.toBe(await right);
    expect(value.artifacts.resolve).toHaveBeenCalledOnce();
    expect(value.images.admit).toHaveBeenCalledOnce();
    expect(value.sources.materialize).toHaveBeenCalledOnce();
  });

  it("retains preparation failures without implicit retry", async () => {
    const value = await harness();
    vi.mocked(value.images.admit).mockRejectedValueOnce(new Error("engine"));
    const first = value.coordinator.prepare();
    const second = value.coordinator.prepare();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow("engine");
    await expect(second).rejects.toThrow("engine");
    expect(value.images.admit).toHaveBeenCalledOnce();
  });

  it("deduplicates exact release and rejects foreign prepared results", async () => {
    const value = await harness();
    const prepared = await value.coordinator.prepare();
    const left = value.coordinator.release(prepared);
    const right = value.coordinator.release(prepared);

    expect(right).toBe(left);
    await expect(left).resolves.toBeUndefined();
    expect(value.sources.release).toHaveBeenCalledOnce();
    await expect(
      value.coordinator.release({ ...prepared } as PreparedExecutionAttempt),
    ).rejects.toMatchObject({ code: "invalid_prepared_attempt" });
  });

  it("retains release failure without retry", async () => {
    const value = await harness();
    const prepared = await value.coordinator.prepare();
    vi.mocked(value.sources.release).mockRejectedValueOnce(new Error("disk"));
    const first = value.coordinator.release(prepared);
    const second = value.coordinator.release(prepared);

    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "release_failed" });
    await expect(second).rejects.toMatchObject({ code: "release_failed" });
    expect(value.sources.release).toHaveBeenCalledOnce();
  });

  it("copies the execution identity before caller mutation", async () => {
    const value = await harness();
    const mutable = structuredClone(value.execution);
    const coordinator = new AttemptPreparationCoordinator({
      execution: mutable,
      projector: new ExecutionPlanProjector(policy),
      artifacts: value.artifacts,
      images: value.images,
      sources: value.sources,
    });
    mutable.lease.fence = 99;

    const prepared = await coordinator.prepare();
    expect(prepared.identity.fence).toBe(value.execution.lease.fence);
  });
});
