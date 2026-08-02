import type { BigIntStats } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NodeBoundedRegularFileReadError,
  type NodeBoundedRegularFileReadRequest,
} from "./bounded-regular-file-contracts";
import {
  readDescriptorBoundRegularFile,
  type DescriptorBoundRegularFileHandle,
} from "./bounded-regular-file-reader-core";

const request: NodeBoundedRegularFileReadRequest = Object.freeze({
  path: "/etc/socrates/input.json",
  maximumBytes: 16,
  expectedOwnerUid: 1_000,
  mode: 0o444,
});

type MetadataOverrides = Partial<
  Pick<
    BigIntStats,
    | "dev"
    | "ino"
    | "mode"
    | "nlink"
    | "uid"
    | "gid"
    | "size"
    | "ctimeNs"
    | "mtimeNs"
  >
> & { regular?: boolean };

function metadata(overrides: MetadataOverrides = {}): BigIntStats {
  const regular = overrides.regular ?? true;
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100444n,
    nlink: 1n,
    uid: 1_000n,
    gid: 1_000n,
    size: 3n,
    ctimeNs: 10n,
    mtimeNs: 11n,
    ...overrides,
    isFile: () => regular,
  } as BigIntStats;
}

class FakeHandle implements DescriptorBoundRegularFileHandle {
  readonly data: Uint8Array;
  readonly metadata: readonly (BigIntStats | Error)[];
  readonly readPlan: readonly number[];
  readonly readFailureAt: number | undefined;
  readonly closeFailure: boolean;
  statCalls = 0;
  readCalls = 0;
  closeCalls = 0;
  position = 0;

  constructor(
    options: {
      data?: Uint8Array;
      metadata?: readonly (BigIntStats | Error)[];
      readPlan?: readonly number[];
      readFailureAt?: number;
      closeFailure?: boolean;
    } = {},
  ) {
    this.data = options.data ?? new Uint8Array([1, 2, 3]);
    this.metadata = options.metadata ?? [metadata(), metadata()];
    this.readPlan = options.readPlan ?? [];
    this.readFailureAt = options.readFailureAt;
    this.closeFailure = options.closeFailure ?? false;
  }

  async stat(): Promise<BigIntStats> {
    const value =
      this.metadata[Math.min(this.statCalls, this.metadata.length - 1)];
    this.statCalls += 1;
    if (value instanceof Error) throw value;
    if (!value) throw new Error("missing fake metadata");
    return value;
  }

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<Readonly<{ bytesRead: number }>> {
    expect(position).toBeNull();
    const call = this.readCalls;
    this.readCalls += 1;
    if (this.readFailureAt === call) throw new Error("private read failure");
    const remaining = this.data.byteLength - this.position;
    const planned = this.readPlan[call] ?? length;
    const bytesRead = Math.min(planned, length, Math.max(remaining, 0));
    if (bytesRead > 0) {
      buffer.set(
        this.data.subarray(this.position, this.position + bytesRead),
        offset,
      );
      this.position += bytesRead;
    }
    return { bytesRead };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure) throw new Error("private close failure");
  }
}

async function expectCode(
  operation: Promise<unknown>,
  code: NodeBoundedRegularFileReadError["code"],
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NodeBoundedRegularFileReadError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  return error as NodeBoundedRegularFileReadError;
}

describe("readDescriptorBoundRegularFile", () => {
  it("reads through one handle, proves EOF and metadata, then closes once", async () => {
    const handle = new FakeHandle({ readPlan: [1, 2, 1] });

    await expect(
      readDescriptorBoundRegularFile(handle, request),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(handle.statCalls).toBe(2);
    expect(handle.readCalls).toBe(3);
    expect(handle.closeCalls).toBe(1);
    expect(handle.position).toBe(3);
  });

  it.each([
    ["non-regular", { regular: false }],
    ["hard linked", { nlink: 2n }],
    ["wrong owner", { uid: 1_001n }],
    ["wrong mode", { mode: 0o100400n }],
  ] as const)("rejects %s initial metadata", async (_name, overrides) => {
    const handle = new FakeHandle({ metadata: [metadata(overrides)] });
    await expectCode(
      readDescriptorBoundRegularFile(handle, request),
      "invalid_metadata",
    );
    expect(handle.readCalls).toBe(0);
    expect(handle.closeCalls).toBe(1);
  });

  it.each([0n, 17n])("rejects the %s-byte initial size", async (size) => {
    const handle = new FakeHandle({ metadata: [metadata({ size })] });
    await expectCode(
      readDescriptorBoundRegularFile(handle, request),
      "size_limit",
    );
    expect(handle.readCalls).toBe(0);
    expect(handle.closeCalls).toBe(1);
  });

  it("rejects early EOF and a byte beyond the attested size", async () => {
    const truncated = new FakeHandle({ data: new Uint8Array([1, 2]) });
    await expectCode(
      readDescriptorBoundRegularFile(truncated, request),
      "content_changed",
    );
    expect(truncated.closeCalls).toBe(1);

    const grown = new FakeHandle({ data: new Uint8Array([1, 2, 3, 4]) });
    await expectCode(
      readDescriptorBoundRegularFile(grown, request),
      "content_changed",
    );
    expect(grown.closeCalls).toBe(1);
  });

  it.each([
    ["device", { dev: 9n }],
    ["inode", { ino: 9n }],
    ["mode", { mode: 0o100400n }],
    ["links", { nlink: 2n }],
    ["uid", { uid: 9n }],
    ["gid", { gid: 9n }],
    ["size", { size: 4n }],
    ["ctime", { ctimeNs: 99n }],
    ["mtime", { mtimeNs: 99n }],
    ["kind", { regular: false }],
  ] as const)("rejects final %s drift", async (_name, overrides) => {
    const handle = new FakeHandle({
      metadata: [metadata(), metadata(overrides)],
    });
    await expectCode(
      readDescriptorBoundRegularFile(handle, request),
      "content_changed",
    );
    expect(handle.closeCalls).toBe(1);
  });

  it("normalizes stat, read, and malformed read-result failures", async () => {
    const statFailure = new FakeHandle({
      metadata: [new Error("secret stat")],
    });
    const statError = await expectCode(
      readDescriptorBoundRegularFile(statFailure, request),
      "read_failed",
    );
    expect(statError.stack).not.toContain("secret stat");

    const readFailure = new FakeHandle({ readFailureAt: 0 });
    const readError = await expectCode(
      readDescriptorBoundRegularFile(readFailure, request),
      "read_failed",
    );
    expect(readError.stack).not.toContain("private read failure");

    const malformed = new FakeHandle({ readPlan: [-1] });
    await expectCode(
      readDescriptorBoundRegularFile(malformed, request),
      "read_failed",
    );
    expect(statFailure.closeCalls).toBe(1);
    expect(readFailure.closeCalls).toBe(1);
    expect(malformed.closeCalls).toBe(1);
  });

  it("reports close failure only when no earlier failure exists", async () => {
    const successfulRead = new FakeHandle({ closeFailure: true });
    const closeError = await expectCode(
      readDescriptorBoundRegularFile(successfulRead, request),
      "close_failed",
    );
    expect(closeError.stack).not.toContain("private close failure");
    expect(successfulRead.closeCalls).toBe(1);

    const primaryFailure = new FakeHandle({
      data: new Uint8Array(),
      closeFailure: true,
    });
    await expectCode(
      readDescriptorBoundRegularFile(primaryFailure, request),
      "content_changed",
    );
    expect(primaryFailure.closeCalls).toBe(1);
  });
});
