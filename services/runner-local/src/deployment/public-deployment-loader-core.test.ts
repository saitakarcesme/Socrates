import type { BigIntStats } from "node:fs";

import { canonicalJson } from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import {
  fixtureApplicationConfiguration,
  fixtureTrustedImages,
} from "../platform/test-fixtures";
import {
  admitLocalRunnerConfigurationBytes,
  admitLocalRunnerTrustedImageBytes,
  maximumLocalRunnerConfigurationBytes,
  maximumLocalRunnerTrustedImageBytes,
} from "./bytes";
import type { NodeBoundedRegularFileReadRequest } from "./bounded-regular-file-contracts";
import {
  LocalRunnerPublicDeploymentLoadError,
  type LocalRunnerPublicDeploymentLoadErrorCode,
} from "./public-deployment-contracts";
import {
  loadDescriptorAnchoredPublicDeployment,
  type PublicDeploymentDirectoryHandle,
  type PublicDeploymentLoaderOperations,
} from "./public-deployment-loader-core";

const encoder = new TextEncoder();
const configurationBytes = encoder.encode(
  canonicalJson(fixtureApplicationConfiguration()),
);
const trustedImageBytes = encoder.encode(canonicalJson(fixtureTrustedImages()));

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

class FakeDirectoryHandle implements PublicDeploymentDirectoryHandle {
  readonly descriptor: number;
  readonly #events: string[];
  readonly #metadata: BigIntStats | Error;
  readonly #closeFailure: boolean;
  closeCalls = 0;
  statCalls = 0;

  constructor(options: {
    descriptor: number;
    events: string[];
    metadata?: BigIntStats | Error;
    closeFailure?: boolean;
  }) {
    this.descriptor = options.descriptor;
    this.#events = options.events;
    this.#metadata = options.metadata ?? directoryMetadata();
    this.#closeFailure = options.closeFailure ?? false;
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
  procType?: bigint;
  procFailure?: boolean;
  openFailureAt?: number;
  metadata?: Readonly<Record<number, BigIntStats | Error>>;
  descriptors?: readonly number[];
  closeFailureAt?: number;
  configurationReadFailure?: boolean;
  configurationAdmissionFailure?: boolean;
  trustedImageReadFailure?: boolean;
  trustedImageAdmissionFailure?: boolean;
}>;

function fakeOperations(options: FakeOptions = {}) {
  const events: string[] = [];
  const handles: FakeDirectoryHandle[] = [];
  const requests: NodeBoundedRegularFileReadRequest[] = [];
  let openCalls = 0;
  const operations: PublicDeploymentLoaderOperations = {
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
      const descriptor = options.descriptors?.[call] ?? 10 + call;
      const handle = new FakeDirectoryHandle({
        descriptor,
        events,
        metadata: options.metadata?.[call],
        closeFailure: options.closeFailureAt === call,
      });
      handles.push(handle);
      return handle;
    },
    readFile: async (request) => {
      requests.push(Object.freeze({ ...request }));
      if (request.path.endsWith("/configuration.v1.json")) {
        events.push("read:configuration");
        if (options.configurationReadFailure) {
          throw new Error("private configuration bytes");
        }
        return Uint8Array.from(configurationBytes);
      }
      events.push("read:trusted-images");
      if (options.trustedImageReadFailure) {
        throw new Error("private image bytes");
      }
      return Uint8Array.from(trustedImageBytes);
    },
    admitConfiguration: (bytes) => {
      events.push("admit:configuration");
      if (options.configurationAdmissionFailure) {
        throw new Error("private configuration document");
      }
      return admitLocalRunnerConfigurationBytes(bytes);
    },
    admitTrustedImages: (bytes) => {
      events.push("admit:trusted-images");
      if (options.trustedImageAdmissionFailure) {
        throw new Error("private image document");
      }
      return admitLocalRunnerTrustedImageBytes(bytes);
    },
  };
  return { events, handles, operations, requests };
}

async function expectCode(
  operation: Promise<unknown>,
  code: LocalRunnerPublicDeploymentLoadErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalRunnerPublicDeploymentLoadError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/private|configuration\.v1/u);
  expect((error as Error).message).not.toMatch(/private|configuration\.v1/u);
  return error as LocalRunnerPublicDeploymentLoadError;
}

describe("loadDescriptorAnchoredPublicDeployment", () => {
  it("retains one exact directory chain through ordered semantic admission", async () => {
    const fake = fakeOperations();

    const result = await loadDescriptorAnchoredPublicDeployment(
      fake.operations,
    );

    expect(result).toEqual({
      configuration: fixtureApplicationConfiguration(),
      trustedImages: fixtureTrustedImages(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.configuration.engine.environment)).toBe(true);
    expect(Object.isFrozen(result.trustedImages)).toBe(true);
    expect(Object.isFrozen(result.trustedImages.images)).toBe(true);
    expect(fake.events).toEqual([
      "proc",
      "open:/",
      "stat:10",
      "open:/proc/self/fd/10/etc",
      "stat:11",
      "open:/proc/self/fd/11/socrates",
      "stat:12",
      "open:/proc/self/fd/12/runner-local",
      "stat:13",
      "read:configuration",
      "admit:configuration",
      "read:trusted-images",
      "admit:trusted-images",
      "close:13",
      "close:12",
      "close:11",
      "close:10",
    ]);
    expect(fake.requests).toEqual([
      {
        path: "/proc/self/fd/13/configuration.v1.json",
        maximumBytes: maximumLocalRunnerConfigurationBytes,
        expectedOwnerUid: 0,
        mode: 0o444,
      },
      {
        path: "/proc/self/fd/13/trusted-images.v1.json",
        maximumBytes: maximumLocalRunnerTrustedImageBytes,
        expectedOwnerUid: 0,
        mode: 0o444,
      },
    ]);
    expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
    expect(fake.handles.every((handle) => handle.statCalls === 1)).toBe(true);
  });

  it("rejects unavailable procfs before opening the deployment tree", async () => {
    for (const options of [
      { procType: 0n },
      { procFailure: true },
    ] satisfies FakeOptions[]) {
      const fake = fakeOperations(options);
      await expectCode(
        loadDescriptorAnchoredPublicDeployment(fake.operations),
        "invalid_host",
      );
      expect(fake.events).toEqual(["proc"]);
      expect(fake.handles).toHaveLength(0);
    }
  });

  it.each([0, 1, 2, 3])(
    "closes every retained parent when directory open %s fails",
    async (openFailureAt) => {
      const fake = fakeOperations({ openFailureAt });
      await expectCode(
        loadDescriptorAnchoredPublicDeployment(fake.operations),
        "open_failed",
      );
      expect(fake.handles).toHaveLength(openFailureAt);
      expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(
        true,
      );
      expect(
        openFailureAt === 0 ? [] : fake.events.slice(-openFailureAt),
      ).toEqual(
        fake.handles.map((handle) => `close:${handle.descriptor}`).toReversed(),
      );
    },
  );

  it.each([
    ["non-directory", directoryMetadata({ directory: false })],
    ["wrong owner", directoryMetadata({ uid: 1n })],
    ["owner writable only", directoryMetadata({ mode: 0o040700n })],
    ["group writable", directoryMetadata({ mode: 0o040775n })],
    ["stat failure", new Error("private stat detail")],
  ] as const)(
    "rejects %s directory metadata before advancing",
    async (_name, value) => {
      const fake = fakeOperations({ metadata: { 1: value } });
      await expectCode(
        loadDescriptorAnchoredPublicDeployment(fake.operations),
        "invalid_metadata",
      );
      expect(fake.events).not.toContain("open:/proc/self/fd/11/socrates");
      expect(fake.handles).toHaveLength(2);
      expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(
        true,
      );
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects malformed descriptor %s before constructing a child path",
    async (descriptor) => {
      const fake = fakeOperations({ descriptors: [descriptor] });
      await expectCode(
        loadDescriptorAnchoredPublicDeployment(fake.operations),
        "invalid_metadata",
      );
      expect(fake.events.some((event) => event.includes("/proc/self/fd"))).toBe(
        false,
      );
      expect(fake.handles[0]?.closeCalls).toBe(1);
    },
  );

  it.each([
    ["read", { configurationReadFailure: true }],
    ["admission", { configurationAdmissionFailure: true }],
  ] as const)(
    "prevents trusted-image access after configuration %s failure",
    async (_name, options) => {
      const fake = fakeOperations(options);
      await expectCode(
        loadDescriptorAnchoredPublicDeployment(fake.operations),
        "configuration_failed",
      );
      expect(fake.events).not.toContain("read:trusted-images");
      expect(fake.events).not.toContain("admit:trusted-images");
      expect(fake.requests).toHaveLength(1);
      expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(
        true,
      );
    },
  );

  it.each([
    ["read", { trustedImageReadFailure: true }],
    ["admission", { trustedImageAdmissionFailure: true }],
  ] as const)("normalizes trusted-image %s failure", async (_name, options) => {
    const fake = fakeOperations(options);
    await expectCode(
      loadDescriptorAnchoredPublicDeployment(fake.operations),
      "trusted_images_failed",
    );
    expect(fake.events).toContain("admit:configuration");
    expect(fake.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
  });

  it("reports close failure only after otherwise successful admission", async () => {
    const closeFailure = fakeOperations({ closeFailureAt: 1 });
    const closeError = await expectCode(
      loadDescriptorAnchoredPublicDeployment(closeFailure.operations),
      "close_failed",
    );
    expect(closeError.stack).not.toContain("private close detail");
    expect(
      closeFailure.handles.every((handle) => handle.closeCalls === 1),
    ).toBe(true);

    const primary = fakeOperations({
      configurationReadFailure: true,
      closeFailureAt: 2,
    });
    await expectCode(
      loadDescriptorAnchoredPublicDeployment(primary.operations),
      "configuration_failed",
    );
    expect(primary.handles.every((handle) => handle.closeCalls === 1)).toBe(
      true,
    );
  });
});
