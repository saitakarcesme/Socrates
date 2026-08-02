import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { types } from "node:util";

import {
  boundedRegularFileReadFailure,
  maximumNodeBoundedRegularFileBytes,
  maximumNodeBoundedRegularFilePathBytes,
  type NodeBoundedRegularFileReadRequest,
} from "./bounded-regular-file-contracts";
import {
  readDescriptorBoundRegularFile,
  type DescriptorBoundRegularFileHandle,
} from "./bounded-regular-file-reader-core";

const expectedKeys = ["path", "maximumBytes", "expectedOwnerUid", "mode"];
const expectedKeySet = new Set(expectedKeys);
const encoder = new TextEncoder();

function containsForbiddenCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0xfffd
    );
  });
}

function dataValue(candidate: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return boundedRegularFileReadFailure("invalid_input");
  }
  return descriptor.value;
}

function admitRequest(candidate: unknown): NodeBoundedRegularFileReadRequest {
  let owner: object;
  let keys: readonly PropertyKey[];
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      types.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      return boundedRegularFileReadFailure("invalid_input");
    }
    owner = candidate;
    keys = Reflect.ownKeys(owner);
  } catch {
    return boundedRegularFileReadFailure("invalid_input");
  }
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeySet.has(key))
  ) {
    return boundedRegularFileReadFailure("invalid_input");
  }

  let path: unknown;
  let maximumBytes: unknown;
  let expectedOwnerUid: unknown;
  let mode: unknown;
  try {
    path = dataValue(owner, "path");
    maximumBytes = dataValue(owner, "maximumBytes");
    expectedOwnerUid = dataValue(owner, "expectedOwnerUid");
    mode = dataValue(owner, "mode");
  } catch {
    return boundedRegularFileReadFailure("invalid_input");
  }

  if (
    typeof path !== "string" ||
    path === "/" ||
    !path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes(",") ||
    path !== path.normalize("NFC") ||
    path !== posix.normalize(path) ||
    containsForbiddenCharacter(path) ||
    encoder.encode(path).byteLength > maximumNodeBoundedRegularFilePathBytes ||
    !Number.isSafeInteger(maximumBytes) ||
    (maximumBytes as number) < 1 ||
    (maximumBytes as number) > maximumNodeBoundedRegularFileBytes ||
    !Number.isSafeInteger(expectedOwnerUid) ||
    (expectedOwnerUid as number) < 0 ||
    (expectedOwnerUid as number) > 4_294_967_294 ||
    !Number.isSafeInteger(mode) ||
    (mode as number) < 1 ||
    (mode as number) > 0o777 ||
    ((mode as number) & 0o444) === 0 ||
    ((mode as number) & 0o333) !== 0
  ) {
    return boundedRegularFileReadFailure("invalid_input");
  }

  return Object.freeze({
    path,
    maximumBytes: maximumBytes as number,
    expectedOwnerUid: expectedOwnerUid as number,
    mode: mode as number,
  });
}

function requiredOpenFlags(): number {
  const noFollow = constants.O_NOFOLLOW as number | undefined;
  const nonBlock = constants.O_NONBLOCK as number | undefined;
  const noControllingTerminal = constants.O_NOCTTY as number | undefined;
  if (
    process.platform !== "linux" ||
    typeof noFollow !== "number" ||
    typeof nonBlock !== "number" ||
    typeof noControllingTerminal !== "number"
  ) {
    return boundedRegularFileReadFailure("unsupported_host");
  }
  return constants.O_RDONLY | noFollow | nonBlock | noControllingTerminal;
}

export class NodeBoundedRegularFileReader {
  constructor() {
    Object.freeze(this);
  }

  async read(candidate: unknown): Promise<Uint8Array> {
    const request = admitRequest(candidate);
    const flags = requiredOpenFlags();
    let handle;
    try {
      handle = await open(request.path, flags);
    } catch {
      return boundedRegularFileReadFailure("open_failed");
    }
    const descriptor: DescriptorBoundRegularFileHandle = {
      stat: () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => {
        const result = await handle.read(buffer, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
      close: () => handle.close(),
    };
    return readDescriptorBoundRegularFile(descriptor, request);
  }
}
