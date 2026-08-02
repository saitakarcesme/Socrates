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
  type ExecutionSourceArtifactResolverFactory,
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
  const identity = Object.freeze({
    runnerId: execution.lease.runnerId,
    taskId: execution.lease.taskId,
    attemptId: execution.lease.attemptId,
    fence: execution.lease.fence,
  });
  const artifacts: ExecutionSourceArtifactResolver = {
    identity,
    resolve: vi.fn(async () => {
      order.push("artifact");
      return artifact;
    }),
  };
  const artifactResolvers: ExecutionSourceArtifactResolverFactory = {
    create: vi.fn(() => artifacts),
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
    artifactResolvers,
    images,
    sources,
  });
  return {
    artifact,
    artifactResolvers,
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
    expect(value.artifactResolvers.create).toHaveBeenCalledOnce();
    expect(value.artifactResolvers.create).toHaveBeenCalledWith(
      prepared.identity,
    );
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
      artifactResolvers: value.artifactResolvers,
      images: value.images,
      sources: value.sources,
    });

    await expect(coordinator.prepare()).rejects.toMatchObject({
      code: "policy_exceeded",
    });
    expect(value.order).toEqual([]);
    expect(value.artifactResolvers.create).not.toHaveBeenCalled();
  });

  it("rejects pre-aborted preparation before any I/O", async () => {
    const value = await harness();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(value.coordinator.prepare(controller.signal)).rejects.toEqual(
      expect.objectContaining({ code: "cancelled" }),
    );
    expect(value.order).toEqual([]);
    expect(value.artifactResolvers.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "factory failure",
      () => {
        throw new Error("private factory failure");
      },
    ],
    ["missing capability", () => undefined],
    [
      "mutable identity",
      (value: Awaited<ReturnType<typeof harness>>) => ({
        identity: { ...value.artifacts.identity },
        resolve: value.artifacts.resolve,
      }),
    ],
    [
      "identity drift",
      (value: Awaited<ReturnType<typeof harness>>) => ({
        identity: Object.freeze({
          ...value.artifacts.identity,
          fence: value.artifacts.identity.fence + 1,
        }),
        resolve: value.artifacts.resolve,
      }),
    ],
    [
      "extra identity authority",
      (value: Awaited<ReturnType<typeof harness>>) => ({
        identity: Object.freeze({
          ...value.artifacts.identity,
          scope: "foreign",
        }),
        resolve: value.artifacts.resolve,
      }),
    ],
    [
      "missing resolve method",
      (value: Awaited<ReturnType<typeof harness>>) => ({
        identity: value.artifacts.identity,
      }),
    ],
  ])("fails closed for %s resolver authority", async (_name, issue) => {
    const value = await harness();
    vi.mocked(value.artifactResolvers.create).mockImplementationOnce(
      () => issue(value) as ExecutionSourceArtifactResolver,
    );

    await expect(value.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_artifact_resolver",
    });
    expect(value.artifacts.resolve).not.toHaveBeenCalled();
    expect(value.images.admit).not.toHaveBeenCalled();
  });

  it.each([
    ["runnerId", "90000000-0000-4000-8000-000000000009"],
    ["taskId", "90000000-0000-4000-8000-000000000009"],
    ["attemptId", "90000000-0000-4000-8000-000000000009"],
    ["fence", 99],
  ] as const)("rejects resolver %s identity drift", async (field, drift) => {
    const value = await harness();
    vi.mocked(value.artifactResolvers.create).mockReturnValueOnce({
      identity: Object.freeze({
        ...value.artifacts.identity,
        [field]: drift,
      }),
      resolve: value.artifacts.resolve,
    });

    await expect(value.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_artifact_resolver",
    });
    expect(value.artifacts.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    [
      "throwing getter",
      Object.defineProperty({}, "create", {
        get: () => {
          throw new Error("private getter failure");
        },
      }),
    ],
  ])(
    "rejects a %s factory method at inert construction",
    async (_name, factory) => {
      const value = await harness();
      expect(
        () =>
          new AttemptPreparationCoordinator({
            execution: value.execution,
            projector: new ExecutionPlanProjector(policy),
            artifactResolvers:
              factory as ExecutionSourceArtifactResolverFactory,
            images: value.images,
            sources: value.sources,
          }),
      ).toThrow(expect.objectContaining({ code: "invalid_artifact_resolver" }));
      expect(value.order).toEqual([]);
    },
  );

  it("captures the factory method and creates exactly one authority", async () => {
    const value = await harness();
    const original = value.artifactResolvers.create;
    value.artifactResolvers.create = vi.fn(() => {
      throw new Error("mutated factory");
    });

    const first = value.coordinator.prepare();
    const second = value.coordinator.prepare();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      identity: value.artifacts.identity,
    });
    expect(original).toHaveBeenCalledOnce();
    expect(value.artifactResolvers.create).not.toHaveBeenCalled();
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

  it("normalizes port failures without invoking later or unowned cleanup", async () => {
    const resolverFailure = await harness();
    const resolverCause = new Error("resolver unavailable");
    vi.mocked(resolverFailure.artifacts.resolve).mockRejectedValueOnce(
      resolverCause,
    );
    await expect(resolverFailure.coordinator.prepare()).rejects.toMatchObject({
      code: "source_unavailable",
      cause: resolverCause,
    });
    expect(resolverFailure.images.admit).not.toHaveBeenCalled();

    const imageFailure = await harness();
    const imageCause = new Error("image unavailable");
    vi.mocked(imageFailure.images.admit).mockRejectedValueOnce(imageCause);
    await expect(imageFailure.coordinator.prepare()).rejects.toMatchObject({
      code: "invalid_image",
      cause: imageCause,
    });
    expect(imageFailure.sources.materialize).not.toHaveBeenCalled();

    const sourceFailure = await harness();
    const sourceCause = new Error("source unavailable");
    vi.mocked(sourceFailure.sources.materialize).mockRejectedValueOnce(
      sourceCause,
    );
    await expect(sourceFailure.coordinator.prepare()).rejects.toMatchObject({
      code: "source_materialization_failed",
      cause: sourceCause,
    });
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

  it("does not erase an unrelated port failure after a concurrent abort", async () => {
    const value = await harness();
    const controller = new AbortController();
    const resolverFailure = new Error("resolver interrupted");
    vi.mocked(value.artifacts.resolve).mockImplementationOnce(async () => {
      controller.abort(new Error("lease lost"));
      throw resolverFailure;
    });

    await expect(
      value.coordinator.prepare(controller.signal),
    ).rejects.toMatchObject({
      code: "source_unavailable",
      cause: resolverFailure,
    });
    expect(value.images.admit).not.toHaveBeenCalled();
  });

  it("recognizes an exact signal rejection as cancellation", async () => {
    const value = await harness();
    const controller = new AbortController();
    const reason = new Error("lease lost");
    vi.mocked(value.artifacts.resolve).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(
      value.coordinator.prepare(controller.signal),
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
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
    expect(value.artifactResolvers.create).toHaveBeenCalledOnce();
    expect(value.images.admit).toHaveBeenCalledOnce();
    expect(value.sources.materialize).toHaveBeenCalledOnce();
  });

  it("retains preparation failures without implicit retry", async () => {
    const value = await harness();
    const cause = new Error("engine");
    vi.mocked(value.images.admit).mockRejectedValueOnce(cause);
    const first = value.coordinator.prepare();
    const second = value.coordinator.prepare();

    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({
      code: "invalid_image",
      cause,
    });
    await expect(second).rejects.toMatchObject({
      code: "invalid_image",
      cause,
    });
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
      artifactResolvers: value.artifactResolvers,
      images: value.images,
      sources: value.sources,
    });
    mutable.lease.fence = 99;

    const prepared = await coordinator.prepare();
    expect(prepared.identity.fence).toBe(value.execution.lease.fence);
  });
});
