import type { BigIntStats } from "node:fs";

import {
  boundedRegularFileReadFailure,
  NodeBoundedRegularFileReadError,
  type NodeBoundedRegularFileReadRequest,
} from "./bounded-regular-file-contracts";

const chunkBytes = 64 * 1_024;
const permissionMask = 0o777n;

export interface DescriptorBoundRegularFileHandle {
  stat(): Promise<BigIntStats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}

function initialMetadata(
  metadata: BigIntStats,
  request: NodeBoundedRegularFileReadRequest,
): number {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.uid !== BigInt(request.expectedOwnerUid) ||
    (metadata.mode & permissionMask) !== BigInt(request.mode)
  ) {
    return boundedRegularFileReadFailure("invalid_metadata");
  }
  if (metadata.size < 1n || metadata.size > BigInt(request.maximumBytes)) {
    return boundedRegularFileReadFailure("size_limit");
  }
  return Number(metadata.size);
}

function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

async function stat(
  handle: DescriptorBoundRegularFileHandle,
): Promise<BigIntStats> {
  try {
    return await handle.stat();
  } catch {
    return boundedRegularFileReadFailure("read_failed");
  }
}

async function read(
  handle: DescriptorBoundRegularFileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
): Promise<number> {
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, offset, length, null));
  } catch {
    return boundedRegularFileReadFailure("read_failed");
  }
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
    return boundedRegularFileReadFailure("read_failed");
  }
  return bytesRead;
}

async function readOpenHandle(
  handle: DescriptorBoundRegularFileHandle,
  request: NodeBoundedRegularFileReadRequest,
): Promise<Uint8Array> {
  const before = await stat(handle);
  const expectedBytes = initialMetadata(before, request);
  const output = new Uint8Array(expectedBytes);
  let offset = 0;

  while (offset < expectedBytes) {
    const length = Math.min(chunkBytes, expectedBytes - offset);
    const bytesRead = await read(handle, output, offset, length);
    if (bytesRead === 0) {
      return boundedRegularFileReadFailure("content_changed");
    }
    offset += bytesRead;
  }

  const eofProbe = new Uint8Array(1);
  if ((await read(handle, eofProbe, 0, eofProbe.byteLength)) !== 0) {
    return boundedRegularFileReadFailure("content_changed");
  }

  const after = await stat(handle);
  if (!sameMetadata(before, after)) {
    return boundedRegularFileReadFailure("content_changed");
  }
  return output;
}

function normalizeReadFailure(error: unknown): NodeBoundedRegularFileReadError {
  return error instanceof NodeBoundedRegularFileReadError
    ? error
    : new NodeBoundedRegularFileReadError("read_failed");
}

export async function readDescriptorBoundRegularFile(
  handle: DescriptorBoundRegularFileHandle,
  request: NodeBoundedRegularFileReadRequest,
): Promise<Uint8Array> {
  let output: Uint8Array | undefined;
  let failure: NodeBoundedRegularFileReadError | undefined;
  try {
    output = await readOpenHandle(handle, request);
  } catch (error) {
    failure = normalizeReadFailure(error);
  }

  try {
    await handle.close();
  } catch {
    failure ??= new NodeBoundedRegularFileReadError("close_failed");
  }

  if (failure) throw failure;
  if (!output) return boundedRegularFileReadFailure("read_failed");
  return output;
}
