import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, type Headers } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  isMaterializedSourceSnapshot,
  resolveMaterializedSourceSnapshot,
} from "./capability";
import {
  SourceSnapshotError,
  SourceSnapshotMaterializer,
  type SourceSnapshotLimits,
} from "./materializer";

const runnerId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000002";
const attemptId = "30000000-0000-4000-8000-000000000003";
const identity = { runnerId, taskId, attemptId, fence: 7 } as const;
const deploymentId = "test-deployment";
const roots: string[] = [];

const limits: SourceSnapshotLimits = {
  maximumArchiveBytes: 1024 * 1024,
  maximumExpandedBytes: 1024 * 1024,
  maximumEntries: 128,
  maximumFileBytes: 256 * 1024,
  maximumPathBytes: 256,
  maximumComponentBytes: 128,
  maximumPathDepth: 16,
};

type ArchiveEntry = {
  header: Headers;
  content?: string | Uint8Array;
};

async function archive(entries: readonly ArchiveEntry[]): Promise<Buffer> {
  const stream = pack();
  for (const entry of entries) {
    stream.entry(entry.header, entry.content ?? Buffer.alloc(0));
  }
  stream.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function* content(bytes: Uint8Array) {
  yield bytes;
}

async function fixture(
  entries: readonly ArchiveEntry[],
  overrides: Partial<SourceSnapshotLimits> = {},
) {
  return fixtureBytes(await archive(entries), overrides);
}

async function fixtureBytes(
  bytes: Uint8Array,
  overrides: Partial<SourceSnapshotLimits> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "socrates-sources-"));
  roots.push(root);
  const store = new LocalContentAddressedArtifactStore(join(root, "artifacts"));
  const artifact = await store.put({
    content: content(bytes),
    expectedDigest: digest(bytes),
    expectedSizeBytes: bytes.byteLength,
    maxSizeBytes: bytes.byteLength,
  });
  const sourceRoot = join(root, "materialized");
  const materializer = new SourceSnapshotMaterializer(store, {
    root: sourceRoot,
    deploymentId,
    runnerId,
    limits: { ...limits, ...overrides },
  });
  return { artifact, bytes, materializer, sourceRoot };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SourceSnapshotMaterializer", () => {
  it("publishes a verified nested tree behind an opaque capability", async () => {
    const { artifact, materializer } = await fixture([
      { header: { name: "src/", type: "directory", mode: 0o755 } },
      {
        header: {
          name: "src/index.ts",
          type: "file",
          mode: 0o644,
          size: 20,
        },
        content: "export const value=1;",
      },
      {
        header: { name: "run.sh", type: "file", mode: 0o755, size: 7 },
        content: "echo ok",
      },
    ]);

    const snapshot = await materializer.materialize({ artifact, identity });
    const tree = resolveMaterializedSourceSnapshot(
      snapshot,
      deploymentId,
      identity,
    );

    expect(isMaterializedSourceSnapshot(snapshot)).toBe(true);
    expect(snapshot).not.toHaveProperty("path");
    expect(snapshot).toMatchObject({
      digest: artifact.digest,
      expandedBytes: 28,
      entryCount: 3,
    });
    await expect(readFile(join(tree, "src", "index.ts"), "utf8")).resolves.toBe(
      "export const value=1;",
    );
    await expect(readFile(join(tree, "run.sh"), "utf8")).resolves.toBe(
      "echo ok",
    );

    await materializer.release(snapshot);
    expect(isMaterializedSourceSnapshot(snapshot)).toBe(false);
    await materializer.release(snapshot);
  });

  it("publishes implicit parent directories as readable", async () => {
    const { artifact, materializer } = await fixture([
      {
        header: {
          name: "implicit/nested/value.txt",
          type: "file",
          size: 2,
        },
        content: "ok",
      },
    ]);
    const snapshot = await materializer.materialize({ artifact, identity });
    const tree = resolveMaterializedSourceSnapshot(
      snapshot,
      deploymentId,
      identity,
    );

    await expect(
      readFile(join(tree, "implicit", "nested", "value.txt"), "utf8"),
    ).resolves.toBe("ok");
    await materializer.release(snapshot);
  });

  it.each([
    {
      name: "traversal",
      entries: [
        {
          header: { name: "../escape", type: "file" as const, size: 1 },
          content: "x",
        },
      ],
    },
    {
      name: "symbolic link",
      entries: [
        {
          header: {
            name: "link",
            type: "symlink" as const,
            linkname: "/etc/passwd",
          },
        },
      ],
    },
    {
      name: "duplicate",
      entries: [
        {
          header: { name: "same", type: "file" as const, size: 1 },
          content: "a",
        },
        {
          header: { name: "same", type: "file" as const, size: 1 },
          content: "b",
        },
      ],
    },
    {
      name: "case collision",
      entries: [
        {
          header: { name: "README", type: "file" as const, size: 1 },
          content: "a",
        },
        {
          header: { name: "readme", type: "file" as const, size: 1 },
          content: "b",
        },
      ],
    },
    {
      name: "unsafe mode",
      entries: [
        {
          header: {
            name: "setuid",
            type: "file" as const,
            mode: 0o4755,
            size: 1,
          },
          content: "x",
        },
      ],
    },
  ])("rejects $name and removes staging state", async ({ entries }) => {
    const { artifact, materializer, sourceRoot } = await fixture(entries);

    await expect(
      materializer.materialize({ artifact, identity }),
    ).rejects.toBeInstanceOf(SourceSnapshotError);
    await expect(readdir(sourceRoot)).resolves.toEqual([
      ".socrates-source-root.json",
    ]);
  });

  it("enforces expanded byte limits before writing an entry", async () => {
    const { artifact, materializer, sourceRoot } = await fixture(
      [
        {
          header: { name: "large", type: "file", size: 5 },
          content: "12345",
        },
      ],
      { maximumFileBytes: 4 },
    );

    await expect(
      materializer.materialize({ artifact, identity }),
    ).rejects.toMatchObject<Partial<SourceSnapshotError>>({
      code: "archive_limit",
    });
    await expect(readdir(sourceRoot)).resolves.toEqual([
      ".socrates-source-root.json",
    ]);
  });

  it("requires a complete POSIX terminator", async () => {
    const complete = await archive([
      {
        header: { name: "file", type: "file", size: 1 },
        content: "x",
      },
    ]);
    const { artifact, materializer, sourceRoot } = await fixtureBytes(
      complete.subarray(0, complete.byteLength - 512),
    );

    await expect(
      materializer.materialize({ artifact, identity }),
    ).rejects.toMatchObject<Partial<SourceSnapshotError>>({
      code: "archive_invalid",
    });
    await expect(readdir(sourceRoot)).resolves.toEqual([
      ".socrates-source-root.json",
    ]);
  });

  it("reserves one materialization per fenced attempt until release", async () => {
    const { artifact, materializer } = await fixture([]);
    const first = await materializer.materialize({ artifact, identity });

    await expect(
      materializer.materialize({ artifact, identity }),
    ).rejects.toMatchObject<Partial<SourceSnapshotError>>({
      code: "conflict",
    });
    await materializer.release(first);
    await expect(
      materializer.materialize({ artifact, identity }),
    ).resolves.toMatchObject({ digest: artifact.digest });
  });

  it("rejects cross-runner attempts before creating state", async () => {
    const { artifact, materializer, sourceRoot } = await fixture([]);

    await expect(
      materializer.materialize({
        artifact,
        identity: {
          ...identity,
          runnerId: "40000000-0000-4000-8000-000000000004",
        },
      }),
    ).rejects.toMatchObject<Partial<SourceSnapshotError>>({
      code: "identity_mismatch",
    });
    await expect(readdir(sourceRoot)).rejects.toThrow();
  });

  it("refuses a populated root without an ownership marker", async () => {
    const { artifact, materializer, sourceRoot } = await fixture([]);
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "foreign.txt"), "keep");

    await expect(
      materializer.materialize({ artifact, identity }),
    ).rejects.toMatchObject<Partial<SourceSnapshotError>>({
      code: "filesystem",
    });
    await expect(
      readFile(join(sourceRoot, "foreign.txt"), "utf8"),
    ).resolves.toBe("keep");
  });
});
