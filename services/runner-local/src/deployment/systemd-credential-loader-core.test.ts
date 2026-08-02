import type { BigIntStats } from "node:fs";

import { describe, expect, it } from "vitest";

import { fixtureCredential } from "../platform/test-fixtures";
import {
  admitLocalRunnerCredentialBytes,
  localRunnerCredentialBytes,
} from "./bytes";
import type { NodeBoundedRegularFileReadRequest } from "./bounded-regular-file-contracts";
import {
  LocalRunnerSystemdCredentialLoadError,
  type LocalRunnerSystemdCredentialLoadErrorCode,
} from "./systemd-credential-contracts";
import {
  loadDescriptorAnchoredSystemdCredential,
  type SystemdCredentialDirectoryHandle,
  type SystemdCredentialLoaderOperations,
} from "./systemd-credential-loader-core";

const encoder = new TextEncoder();
const credentialBytes = encoder.encode(fixtureCredential);
const effectiveUid = 1_001;

type DirectoryMetadataOverrides = Partial<Pick<BigIntStats, "mode" | "uid">> & {
  directory?: boolean;
};

function directoryMetadata(
  overrides: DirectoryMetadataOverrides = {},
): BigIntStats {
  const directory = overrides.directory ?? true;
  return {
    mode: 0o040755n,
    uid: 0n,
    ...overrides,
    isDirectory: () => directory,
  } as BigIntStats;
}

function unitDirectoryMetadata(owner = BigInt(effectiveUid)): BigIntStats {
  return directoryMetadata({ mode: 0o040500n, uid: owner });
}

class FakeDirectoryHandle implements SystemdCredentialDirectoryHandle {
  readonly descriptor: number;
  readonly #events: string[];
  readonly #metadata: BigIntStats | Error;
  readonly #closeFailure: boolean;
  closeCalls = 0;
  statCalls = 0;

  constructor(options: {
    descriptor: number;
    events: string[];
    metadata: BigIntStats | Error;
    closeFailure: boolean;
  }) {
    this.descriptor = options.descriptor;
    this.#events = options.events;
    this.#metadata = options.metadata;
    this.#closeFailure = options.closeFailure;
  }

  async stat(): Promise<BigIntStats> {
    this.statCalls += 1;
    this.#events.push(`stat:${this.descriptor}`);
    if (this.#metadata instanceof Error) throw this.#metadata;
    return this.#metadata;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#events.push(`close:${this.descriptor}`);
    if (this.#closeFailure) throw new Error("private close detail");
  }
}

type FakeOptions = Readonly<{
  environment?: unknown;
  environmentFailure?: boolean;
  identity?: unknown;
  identityFailure?: boolean;
  procType?: bigint;
  procFailure?: boolean;
  openFailureAt?: number;
  metadata?: Readonly<Record<number, BigIntStats | Error>>;
  descriptors?: readonly number[];
  closeFailureAt?: number;
  readFailure?: boolean;
  admissionFailure?: boolean;
}>;

function fakeOperations(options: FakeOptions = {}) {
  const events: string[] = [];
  const handles: FakeDirectoryHandle[] = [];
  const requests: NodeBoundedRegularFileReadRequest[] = [];
  let openCalls = 0;
  const operations: SystemdCredentialLoaderOperations = {
    readCredentialsDirectory: () => {
      events.push("environment");
      if (options.environmentFailure) {
        throw new Error("private environment detail");
      }
      return Object.hasOwn(options, "environment")
        ? options.environment
        : "/run/credentials/socrates-runner-local.service";
    },
    readEffectiveUid: () => {
      events.push("identity");
      if (options.identityFailure) {
        throw new Error("private identity detail");
      }
      return Object.hasOwn(options, "identity")
        ? options.identity
        : effectiveUid;
    },
    inspectProcFilesystem: async () => {
      events.push("proc");
      if (options.procFailure) throw new Error("private proc detail");
      return options.procType ?? 0x9fa0n;
    },
    openDirectory: async (path) => {
      const call = openCalls;
      openCalls += 1;
      events.push(`open:${path}`);
      if (options.openFailureAt === call) {
        throw new Error("private open detail");
      }
      const descriptor = options.descriptors?.[call] ?? 20 + call;
      const metadata =
        options.metadata?.[call] ??
        (call === 3 ? unitDirectoryMetadata() : directoryMetadata());
      const handle = new FakeDirectoryHandle({
        descriptor,
        events,
        metadata,
        closeFailure: options.closeFailureAt === call,
      });
      handles.push(handle);
      return handle;
    },
    readFile: async (request) => {
      events.push("read:credential");
      requests.push(Object.freeze({ ...request }));
      if (options.readFailure) throw new Error("private token bytes");
      return Uint8Array.from(credentialBytes);
    },
    admitCredential: (bytes) => {
      events.push("admit:credential");
      if (options.admissionFailure) throw new Error("private token value");
      return admitLocalRunnerCredentialBytes(bytes);
    },
  };
  return { events, handles, operations, requests };
}

async function expectCode(
  operation: Promise<unknown>,
  code: LocalRunnerSystemdCredentialLoadErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalRunnerSystemdCredentialLoadError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(
    /private|runner-bearer|credentials\/socrates|srt1/u,
  );
  expect((error as Error).message).not.toMatch(
    /private|runner-bearer|credentials\/socrates|srt1/u,
  );
  return error as LocalRunnerSystemdCredentialLoadError;
}

describe("loadDescriptorAnchoredSystemdCredential", () => {
  it.each([
    ["service", BigInt(effectiveUid), effectiveUid],
    ["root ACL", 0n, 0],
  ] as const)(
    "retains the exact descriptor chain for the %s owner model",
    async (_name, owner, expectedOwnerUid) => {
      const fake = fakeOperations({
        metadata: { 3: unitDirectoryMetadata(owner) },
      });

      const result = await loadDescriptorAnchoredSystemdCredential(
        fake.operations,
      );

      expect(result).toBe(fixtureCredential);
      expect(fake.events).toEqual([
        "environment",
        "identity",
        "proc",
        "open:/",
        "stat:20",
        "open:/proc/self/fd/20/run",
        "stat:21",
        "open:/proc/self/fd/21/credentials",
        "stat:22",
        "open:/proc/self/fd/22/socrates-runner-local.service",
        "stat:23",
        "read:credential",
        "admit:credential",
        "close:23",
        "close:22",
        "close:21",
        "close:20",
      ]);
      expect(fake.requests).toEqual([
        {
          path: "/proc/self/fd/23/runner-bearer-token",
          maximumBytes: localRunnerCredentialBytes,
          expectedOwnerUid,
          mode: 0o400,
        },
      ]);
      expect(fake.handles.every((handle) => handle.statCalls === 1)).toBe(true);
      expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(
        true,
      );
    },
  );

  it.each([
    ["missing", null],
    ["empty", ""],
    ["alternate", "/run/credentials/other.service"],
    ["non-string", 1],
  ] as const)(
    "rejects %s environment before identity",
    async (_name, value) => {
      const fake = fakeOperations({ environment: value });
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "invalid_environment",
      );
      expect(fake.events).toEqual(["environment"]);
    },
  );

  it("normalizes a throwing environment read before identity", async () => {
    const fake = fakeOperations({ environmentFailure: true });
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(fake.operations),
      "invalid_environment",
    );
    expect(fake.events).toEqual(["environment"]);
  });

  it.each([undefined, 0, -1, 1.5, 4_294_967_295])(
    "rejects invalid effective identity %s before procfs",
    async (identity) => {
      const fake = fakeOperations({ identity });
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "invalid_identity",
      );
      expect(fake.events).toEqual(["environment", "identity"]);
    },
  );

  it("normalizes a throwing identity read before procfs", async () => {
    const fake = fakeOperations({ identityFailure: true });
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(fake.operations),
      "invalid_identity",
    );
    expect(fake.events).toEqual(["environment", "identity"]);
  });

  it.each([{ procType: 0n }, { procFailure: true }] satisfies FakeOptions[])(
    "rejects unavailable procfs before opening the tree %#",
    async (options) => {
      const fake = fakeOperations(options);
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "invalid_host",
      );
      expect(fake.events).toEqual(["environment", "identity", "proc"]);
    },
  );

  it.each([0, 1, 2, 3])(
    "closes every retained parent when directory open %s fails",
    async (openFailureAt) => {
      const fake = fakeOperations({ openFailureAt });
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "open_failed",
      );
      expect(fake.handles).toHaveLength(openFailureAt);
      expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(
        true,
      );
    },
  );

  it.each([
    ["non-directory", directoryMetadata({ directory: false })],
    ["wrong public owner", directoryMetadata({ uid: 1n })],
    ["wrong public mode", directoryMetadata({ mode: 0o040775n })],
    ["stat failure", new Error("private stat detail")],
  ] as const)("rejects %s before advancing", async (_name, metadata) => {
    const fake = fakeOperations({ metadata: { 1: metadata } });
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(fake.operations),
      "invalid_metadata",
    );
    expect(fake.events).not.toContain("open:/proc/self/fd/21/credentials");
    expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
  });

  it.each([
    ["wrong unit owner", unitDirectoryMetadata(2_002n)],
    ["writable unit", directoryMetadata({ mode: 0o040700n, uid: 0n })],
    ["search-only unit", directoryMetadata({ mode: 0o040100n, uid: 0n })],
  ] as const)(
    "rejects %s before credential access",
    async (_name, metadata) => {
      const fake = fakeOperations({ metadata: { 3: metadata } });
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "invalid_metadata",
      );
      expect(fake.events).not.toContain("read:credential");
    },
  );

  it.each([
    ["read", { readFailure: true }],
    ["admission", { admissionFailure: true }],
  ] as const)("normalizes credential %s failure", async (_name, options) => {
    const fake = fakeOperations(options);
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(fake.operations),
      "credential_failed",
    );
    expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
  });

  it("preserves primary failure over close failure", async () => {
    const successful = fakeOperations({ closeFailureAt: 1 });
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(successful.operations),
      "close_failed",
    );
    expect(successful.handles.every((handle) => handle.closeCalls === 1)).toBe(
      true,
    );

    const primary = fakeOperations({
      admissionFailure: true,
      closeFailureAt: 2,
    });
    await expectCode(
      loadDescriptorAnchoredSystemdCredential(primary.operations),
      "credential_failed",
    );
    expect(primary.handles.every((handle) => handle.closeCalls === 1)).toBe(
      true,
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects malformed descriptor %s before constructing a child path",
    async (descriptor) => {
      const fake = fakeOperations({ descriptors: [descriptor] });
      await expectCode(
        loadDescriptorAnchoredSystemdCredential(fake.operations),
        "invalid_metadata",
      );
      expect(fake.events.some((event) => event.includes("/proc/self/fd"))).toBe(
        false,
      );
      expect(fake.handles[0]?.closeCalls).toBe(1);
    },
  );
});
