import {
  ArtifactStoreError,
  type ArtifactStore,
  type PutArtifactInput,
} from "@socrates/artifact-store";
import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedSourceArtifactResolver,
  BoundedSourceArtifactResolverError,
  type RunnerSourceSnapshotTransport,
  type SourceSnapshotStream,
} from "./artifact-resolver";
import { sourceSnapshotMediaType } from "./materializer";

const roots: string[] = [];
const identity = Object.freeze({
  runnerId: "10000000-0000-4000-8000-000000000001",
  taskId: "20000000-0000-4000-8000-000000000002",
  attemptId: "30000000-0000-4000-8000-000000000003",
  fence: 4,
});
const snapshotId = "40000000-0000-4000-8000-000000000004";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function harness(content = new TextEncoder().encode("source archive")) {
  const root = await mkdtemp(join(tmpdir(), "socrates-source-resolver-"));
  roots.push(root);
  const descriptor: SourceSnapshotStream = {
    mediaType: sourceSnapshotMediaType,
    sizeBytes: content.byteLength,
    content: (async function* () {
      yield content.subarray(0, 3);
      yield content.subarray(3);
    })(),
  };
  const transport: RunnerSourceSnapshotTransport = {
    open: vi.fn(async () => descriptor),
  };
  const artifacts = new LocalContentAddressedArtifactStore(
    join(root, "artifacts"),
  );
  const resolver = new BoundedSourceArtifactResolver({
    identity,
    maximumArchiveBytes: 1_024,
    transport,
    artifacts,
  });
  return {
    artifacts,
    content,
    digest: digest(content),
    resolver,
    transport,
  };
}

describe("BoundedSourceArtifactResolver", () => {
  it("streams the exact attempt-bound source into the verified store", async () => {
    const value = await harness();
    const controller = new AbortController();

    const artifact = await value.resolver.resolve({
      snapshotId,
      digest: value.digest,
      signal: controller.signal,
    });

    expect(artifact).toEqual({
      digest: value.digest,
      sizeBytes: value.content.byteLength,
    });
    expect(value.transport.open).toHaveBeenCalledWith({
      identity,
      snapshotId,
      digest: value.digest,
      signal: controller.signal,
    });
    const verified = await value.artifacts.verify({
      expectedDigest: value.digest,
      expectedSizeBytes: value.content.byteLength,
    });
    expect(verified).toEqual(artifact);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid maximum %s at construction",
    (maximumArchiveBytes) => {
      expect(
        () =>
          new BoundedSourceArtifactResolver({
            identity,
            maximumArchiveBytes,
            transport: { open: vi.fn() },
            artifacts: {} as ArtifactStore,
          }),
      ).toThrow(BoundedSourceArtifactResolverError);
    },
  );

  it("rejects invalid attempt identity at construction", () => {
    expect(
      () =>
        new BoundedSourceArtifactResolver({
          identity: { ...identity, fence: 0 },
          maximumArchiveBytes: 1,
          transport: { open: vi.fn() },
          artifacts: {} as ArtifactStore,
        }),
    ).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
  });

  it("shares one exact resolution promise", async () => {
    const value = await harness();
    const input = { snapshotId, digest: value.digest };
    const first = value.resolver.resolve(input);
    const second = value.resolver.resolve(input);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(await second);
    expect(value.transport.open).toHaveBeenCalledOnce();
    expect(value.resolver.resolve(input)).toBe(first);
  });

  it("rejects source and signal authority drift without replacing the operation", async () => {
    const value = await harness();
    const signal = new AbortController().signal;
    const first = value.resolver.resolve({
      snapshotId,
      digest: value.digest,
      signal,
    });

    await expect(
      value.resolver.resolve({
        snapshotId: "50000000-0000-4000-8000-000000000005",
        digest: value.digest,
        signal,
      }),
    ).rejects.toMatchObject({ code: "authority_conflict" });
    await expect(
      value.resolver.resolve({
        snapshotId,
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signal,
      }),
    ).rejects.toMatchObject({ code: "authority_conflict" });
    await expect(
      value.resolver.resolve({
        snapshotId,
        digest: value.digest,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "authority_conflict" });
    await expect(first).resolves.toMatchObject({ digest: value.digest });
    expect(value.transport.open).toHaveBeenCalledOnce();
  });

  it.each([
    { snapshotId: "invalid", digest: "sha256:" + "a".repeat(64) },
    { snapshotId, digest: "SHA256:" + "a".repeat(64) },
    { snapshotId, digest: "sha256:" + "A".repeat(64) },
  ])("rejects malformed reference before transport", async (input) => {
    const value = await harness();
    await expect(value.resolver.resolve(input)).rejects.toMatchObject({
      code: "invalid_descriptor",
    });
    expect(value.transport.open).not.toHaveBeenCalled();
  });

  it("retains missing source and transport failures", async () => {
    const missing = await harness();
    vi.mocked(missing.transport.open).mockResolvedValueOnce(undefined);
    const first = missing.resolver.resolve({
      snapshotId,
      digest: missing.digest,
    });
    await expect(first).rejects.toMatchObject({ code: "source_unavailable" });
    expect(
      missing.resolver.resolve({ snapshotId, digest: missing.digest }),
    ).toBe(first);

    const failed = await harness();
    vi.mocked(failed.transport.open).mockRejectedValueOnce(
      new Error("transport unavailable"),
    );
    const rejection = failed.resolver.resolve({
      snapshotId,
      digest: failed.digest,
    });
    await expect(rejection).rejects.toThrow("transport unavailable");
    await expect(rejection).rejects.toThrow("transport unavailable");
    expect(failed.transport.open).toHaveBeenCalledOnce();
  });

  it.each([
    { mediaType: "application/octet-stream", sizeBytes: 1 },
    { mediaType: sourceSnapshotMediaType, sizeBytes: 0 },
    { mediaType: sourceSnapshotMediaType, sizeBytes: -1 },
    { mediaType: sourceSnapshotMediaType, sizeBytes: 0.5 },
    { mediaType: sourceSnapshotMediaType, sizeBytes: Number.NaN },
    { mediaType: sourceSnapshotMediaType, sizeBytes: Number.POSITIVE_INFINITY },
    { mediaType: sourceSnapshotMediaType, sizeBytes: 1_025 },
  ])("rejects invalid descriptor %#", async ({ mediaType, sizeBytes }) => {
    const value = await harness();
    vi.mocked(value.transport.open).mockResolvedValueOnce({
      mediaType,
      sizeBytes,
      content: (async function* () {
        yield value.content;
      })(),
    });

    await expect(
      value.resolver.resolve({ snapshotId, digest: value.digest }),
    ).rejects.toMatchObject({ code: "invalid_descriptor" });
  });

  it.each([
    { name: "truncated", content: new Uint8Array([1]), declared: 2 },
    { name: "overflow", content: new Uint8Array([1, 2]), declared: 1 },
  ])("rejects $name streams", async ({ content, declared }) => {
    const value = await harness(content);
    vi.mocked(value.transport.open).mockResolvedValueOnce({
      mediaType: sourceSnapshotMediaType,
      sizeBytes: declared,
      content: (async function* () {
        yield content;
      })(),
    });

    await expect(
      value.resolver.resolve({ snapshotId, digest: value.digest }),
    ).rejects.toBeInstanceOf(ArtifactStoreError);
  });

  it("rejects stream digest drift", async () => {
    const value = await harness();
    const wrong = new TextEncoder().encode("wrong archive!");
    vi.mocked(value.transport.open).mockResolvedValueOnce({
      mediaType: sourceSnapshotMediaType,
      sizeBytes: wrong.byteLength,
      content: (async function* () {
        yield wrong;
      })(),
    });

    await expect(
      value.resolver.resolve({ snapshotId, digest: value.digest }),
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("rejects pre-aborted resolution before transport", async () => {
    const value = await harness();
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));

    await expect(
      value.resolver.resolve({
        snapshotId,
        digest: value.digest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(value.transport.open).not.toHaveBeenCalled();
  });

  it("rejects mid-stream cancellation without publishing an artifact", async () => {
    const value = await harness();
    const controller = new AbortController();
    vi.mocked(value.transport.open).mockResolvedValueOnce({
      mediaType: sourceSnapshotMediaType,
      sizeBytes: value.content.byteLength,
      content: (async function* () {
        yield value.content.subarray(0, 1);
        controller.abort(new Error("lease lost"));
        yield value.content.subarray(1);
      })(),
    });

    await expect(
      value.resolver.resolve({
        snapshotId,
        digest: value.digest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      value.artifacts.verify({
        expectedDigest: value.digest,
        expectedSizeBytes: value.content.byteLength,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects cancellation after store verification", async () => {
    const value = await harness();
    const controller = new AbortController();
    const artifacts: ArtifactStore = {
      put: async (input: PutArtifactInput) => {
        const artifact = await value.artifacts.put(input);
        controller.abort(new Error("lease lost"));
        return artifact;
      },
      verify: (input) => value.artifacts.verify(input),
      read: (input) => value.artifacts.read(input),
    };
    const resolver = new BoundedSourceArtifactResolver({
      identity,
      maximumArchiveBytes: 1_024,
      transport: value.transport,
      artifacts,
    });

    await expect(
      resolver.resolve({
        snapshotId,
        digest: value.digest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a forged artifact-store capability", async () => {
    const value = await harness();
    const artifacts: ArtifactStore = {
      put: vi.fn(async () => ({
        digest: value.digest,
        sizeBytes: value.content.byteLength,
      })),
      verify: vi.fn(),
      read: vi.fn(),
    };
    const resolver = new BoundedSourceArtifactResolver({
      identity,
      maximumArchiveBytes: 1_024,
      transport: value.transport,
      artifacts,
    });

    await expect(
      resolver.resolve({ snapshotId, digest: value.digest }),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
  });
});
