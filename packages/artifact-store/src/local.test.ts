import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStoreError, isVerifiedArtifact } from "./index";
import { LocalContentAddressedArtifactStore } from "./local";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "socrates-artifacts-"));
  roots.push(root);
  return root;
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function* chunks(...content: Uint8Array[]) {
  yield* content;
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("LocalContentAddressedArtifactStore", () => {
  it("publishes verified content at a digest-derived private path", async () => {
    const root = await temporaryRoot();
    const store = new LocalContentAddressedArtifactStore(root);
    const content = new TextEncoder().encode("bounded evidence");
    const expectedDigest = digest(content);

    const verified = await store.put({
      content: chunks(content.slice(0, 7), content.slice(7)),
      expectedDigest,
      expectedSizeBytes: content.byteLength,
      maxSizeBytes: 1_024,
    });

    expect(isVerifiedArtifact(verified)).toBe(true);
    expect(
      await store.verify({
        expectedDigest,
        expectedSizeBytes: content.byteLength,
      }),
    ).toEqual(verified);
    const hex = expectedDigest.slice("sha256:".length);
    await expect(
      readFile(join(root, "objects", hex.slice(0, 2), hex.slice(2))),
    ).resolves.toEqual(Buffer.from(content));
  });

  it("is idempotent for identical content", async () => {
    const root = await temporaryRoot();
    const store = new LocalContentAddressedArtifactStore(root);
    const content = new TextEncoder().encode("same content");
    const input = {
      expectedDigest: digest(content),
      expectedSizeBytes: content.byteLength,
      maxSizeBytes: content.byteLength,
    };

    await store.put({ ...input, content: chunks(content) });
    await expect(
      store.put({ ...input, content: chunks(content) }),
    ).resolves.toEqual({
      digest: input.expectedDigest,
      sizeBytes: input.expectedSizeBytes,
    });
  });

  it("streams a verified object once without exposing its path", async () => {
    const store = new LocalContentAddressedArtifactStore(await temporaryRoot());
    const content = new TextEncoder().encode("source snapshot");
    const artifact = await store.put({
      content: chunks(content),
      expectedDigest: digest(content),
      expectedSizeBytes: content.byteLength,
      maxSizeBytes: content.byteLength,
    });
    const stream = store.read({
      artifact,
      maxSizeBytes: content.byteLength,
    });

    await expect(collect(stream)).resolves.toEqual(Buffer.from(content));
    await expect(collect(stream)).rejects.toMatchObject<
      Partial<ArtifactStoreError>
    >({
      code: "invalid_capability",
    });
    expect(artifact).not.toHaveProperty("path");
  });

  it("rejects forged read capabilities before opening storage", async () => {
    const store = new LocalContentAddressedArtifactStore(await temporaryRoot());
    const forged = {
      digest: `sha256:${"0".repeat(64)}`,
      sizeBytes: 0,
    };

    expect(() =>
      store.read({
        artifact: forged,
        maxSizeBytes: 0,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ArtifactStoreError>>({
        code: "invalid_capability",
      }),
    );
  });

  it("rehashes content changed after capability issuance", async () => {
    const root = await temporaryRoot();
    const store = new LocalContentAddressedArtifactStore(root);
    const content = new TextEncoder().encode("original");
    const expectedDigest = digest(content);
    const artifact = await store.put({
      content: chunks(content),
      expectedDigest,
      expectedSizeBytes: content.byteLength,
      maxSizeBytes: content.byteLength,
    });
    const hex = expectedDigest.slice("sha256:".length);
    await writeFile(
      join(root, "objects", hex.slice(0, 2), hex.slice(2)),
      "mutated!",
    );

    await expect(
      collect(store.read({ artifact, maxSizeBytes: content.byteLength })),
    ).rejects.toMatchObject<Partial<ArtifactStoreError>>({
      code: "digest_mismatch",
    });
  });

  it.each([
    {
      name: "traversal-shaped digest",
      code: "invalid_digest",
      expectedDigest: "sha256:../../outside",
      expectedSizeBytes: 1,
      maxSizeBytes: 1,
      content: new Uint8Array([1]),
    },
    {
      name: "digest mismatch",
      code: "digest_mismatch",
      expectedDigest: `sha256:${"0".repeat(64)}`,
      expectedSizeBytes: 1,
      maxSizeBytes: 1,
      content: new Uint8Array([1]),
    },
    {
      name: "declared oversize",
      code: "size_limit_exceeded",
      expectedDigest: `sha256:${"0".repeat(64)}`,
      expectedSizeBytes: 2,
      maxSizeBytes: 1,
      content: new Uint8Array([1, 2]),
    },
  ])("rejects $name without publishing an object", async (fixture) => {
    const store = new LocalContentAddressedArtifactStore(await temporaryRoot());

    await expect(
      store.put({
        content: chunks(fixture.content),
        expectedDigest: fixture.expectedDigest,
        expectedSizeBytes: fixture.expectedSizeBytes,
        maxSizeBytes: fixture.maxSizeBytes,
      }),
    ).rejects.toMatchObject<Partial<ArtifactStoreError>>({
      code: fixture.code,
    });
  });
});
