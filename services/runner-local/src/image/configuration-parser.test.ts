import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { SandboxImageCatalog } from "./catalog";
import {
  maximumTrustedImageCatalogImages,
  maximumTrustedImageCommandArguments,
  maximumTrustedImageCommandBytes,
  maximumTrustedImageCommandValueBytes,
  maximumTrustedImageConfigurationDepth,
  maximumTrustedImageConfigurationNodes,
  maximumTrustedImageEnvironmentBytes,
  maximumTrustedImageEnvironmentEntries,
  maximumTrustedImageEnvironmentEntryBytes,
} from "./configuration-contracts";
import {
  LocalRunnerTrustedImageConfigurationError,
  parseLocalRunnerTrustedImageCatalogConfiguration,
} from "./configuration-parser";

function digest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function declaration(index = 1) {
  return {
    digest: digest(index),
    manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
    configurationDigest: digest(10_000 + index),
    architecture: "amd64",
    runtimeBuildDigest: digest(20_000 + index),
    runtimeBundleDigest: digest(30_000 + index),
    runtime: {
      executable: "/usr/local/bin/node",
      arguments: ["/opt/socrates/task-runtime.mjs"],
    },
    profileProbe: {
      executable: "/usr/local/bin/node",
      arguments: ["-e", "process.stdout.write('probe')"],
    },
    environment: [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=22.23.1",
    ],
  };
}

function configuration(images = [declaration()]) {
  return { version: "1", images };
}

function failure(candidate: unknown): unknown {
  try {
    parseLocalRunnerTrustedImageCatalogConfiguration(candidate);
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected trusted image configuration failure.");
}

function expectInvalid(candidate: unknown, code = "invalid_configuration") {
  expect(() =>
    parseLocalRunnerTrustedImageCatalogConfiguration(candidate),
  ).toThrow(
    expect.objectContaining({
      name: "LocalRunnerTrustedImageConfigurationError",
      code,
      message:
        code === "invalid_candidate"
          ? "Trusted image configuration candidate is not plain bounded data."
          : "Trusted image configuration is invalid.",
    }),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function environmentEntry(index: number, size: number): string {
  const prefix = `E${index}=`;
  if (prefix.length > size)
    throw new Error("Environment fixture is too small.");
  return `${prefix}${"x".repeat(size - prefix.length)}`;
}

describe("trusted image catalog configuration", () => {
  it("returns one exact detached deeply frozen digest-authority snapshot", () => {
    const candidate = configuration();
    const parsed = parseLocalRunnerTrustedImageCatalogConfiguration(candidate);
    candidate.images[0]!.digest = digest(99);
    candidate.images[0]!.runtime.executable = "/mutated";
    candidate.images[0]!.runtime.arguments[0] = "mutated";
    candidate.images[0]!.environment[0] = "MUTATED=true";

    expect(parsed).toEqual(configuration());
    expect(parsed).not.toBe(candidate);
    expect(parsed.images).not.toBe(candidate.images);
    expect(parsed.images[0]).not.toHaveProperty("reference");
    expect(parsed.images[0]).not.toHaveProperty("manifestDigest");
    expectDeepFrozen(parsed);
  });

  it("is deterministic while issuing independent snapshots", () => {
    const first =
      parseLocalRunnerTrustedImageCatalogConfiguration(configuration());
    const second =
      parseLocalRunnerTrustedImageCatalogConfiguration(configuration());

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.images).not.toBe(second.images);
    expect(first.images[0]?.runtime).not.toBe(second.images[0]?.runtime);
  });

  it("constructs the existing catalog inertly without later configuration failure", () => {
    const parsed =
      parseLocalRunnerTrustedImageCatalogConfiguration(configuration());
    const inspect = vi.fn();
    const verify = vi.fn();

    expect(
      () => new SandboxImageCatalog(parsed.images, { inspect }, { verify }),
    ).not.toThrow();
    expect(inspect).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    ["function", { ...configuration(), private: () => true }],
    ["custom prototype", Object.assign(new Date(0), configuration())],
    ["symbol", { ...configuration(), [Symbol("private")]: true }],
    [
      "throwing proxy",
      new Proxy(configuration(), {
        ownKeys: () => {
          throw new Error("private proxy failure");
        },
      }),
    ],
  ])("rejects unsafe candidate structure: %s", (_name, candidate) => {
    expectInvalid(candidate, "invalid_candidate");
  });

  it("rejects accessors and setters without invoking them", () => {
    const get = vi.fn(() => "private");
    const set = vi.fn();
    const accessor = Object.defineProperty(configuration(), "private", {
      enumerable: true,
      get,
      set,
    });

    expectInvalid(accessor, "invalid_candidate");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("normalizes a proxy that changes behavior after structural admission", () => {
    const target = configuration();
    let descriptors = 0;
    const candidate = new Proxy(target, {
      ownKeys: () => {
        descriptors += 1;
        return Reflect.ownKeys(target);
      },
      get: (object, property, receiver) => {
        if (descriptors > 0 && property === "version") {
          throw new Error("private late proxy failure");
        }
        return Reflect.get(object, property, receiver);
      },
    });

    const error = failure(candidate);
    expect(error).toMatchObject({ code: "invalid_candidate" });
    expect(String(error)).not.toContain("private");
  });

  it("rejects cycles, sparse arrays, extension keys, depth, and node bombs", () => {
    const cyclic = configuration() as ReturnType<typeof configuration> & {
      self?: unknown;
    };
    cyclic.self = cyclic;
    expectInvalid(cyclic, "invalid_candidate");

    const sparse = configuration();
    sparse.images = new Array(2) as ReturnType<typeof declaration>[];
    sparse.images[1] = declaration();
    expectInvalid(sparse, "invalid_candidate");

    const extended = configuration();
    (
      extended.images as ReturnType<typeof declaration>[] & { extra?: true }
    ).extra = true;
    expectInvalid(extended, "invalid_candidate");

    let deep: unknown = true;
    for (
      let index = 0;
      index < maximumTrustedImageConfigurationDepth + 1;
      index += 1
    ) {
      deep = { value: deep };
    }
    expectInvalid(deep, "invalid_candidate");

    expectInvalid(
      Array.from({ length: maximumTrustedImageConfigurationNodes }, () => true),
      "invalid_candidate",
    );
  });

  it.each([
    null,
    true,
    "1",
    [],
    {},
    { ...configuration(), version: "2" },
    { ...configuration(), unknown: true },
    { version: "1" },
  ])("rejects a structurally safe non-contract candidate %#", (candidate) => {
    expectInvalid(candidate);
  });

  it("enforces exact catalog count and digest uniqueness", () => {
    expectInvalid(configuration([]));
    const maximum = Array.from(
      { length: maximumTrustedImageCatalogImages },
      (_, index) => declaration(index + 1),
    );
    expect(
      parseLocalRunnerTrustedImageCatalogConfiguration(configuration(maximum))
        .images,
    ).toHaveLength(maximumTrustedImageCatalogImages);
    expectInvalid(
      configuration([
        ...maximum,
        declaration(maximumTrustedImageCatalogImages + 1),
      ]),
    );
    expectInvalid(configuration([declaration(1), declaration(1)]));
  });

  it.each([
    ["amd64", "application/vnd.oci.image.manifest.v1+json"],
    ["arm64", "application/vnd.docker.distribution.manifest.v2+json"],
  ] as const)(
    "admits the closed %s platform and manifest contract",
    (architecture, manifestMediaType) => {
      const parsed = parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([{ ...declaration(), architecture, manifestMediaType }]),
      );
      expect(parsed.images[0]).toMatchObject({
        architecture,
        manifestMediaType,
      });
    },
  );

  it.each([
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    `sha512:${"a".repeat(64)}`,
    `registry.example/runtime@${digest(1)}`,
    "runtime:latest",
  ])("rejects non-canonical digest identity %s", (candidateDigest) => {
    expectInvalid(
      configuration([{ ...declaration(), digest: candidateDigest }]),
    );
  });

  it("rejects digest aliases and unknown declaration fields", () => {
    expectInvalid(
      configuration([
        {
          ...declaration(),
          reference: digest(1),
          manifestDigest: digest(1),
        },
      ]),
    );
  });

  it.each([
    ["manifest media", { manifestMediaType: "application/json" }],
    ["architecture", { architecture: "x64" }],
    ["configuration digest", { configurationDigest: "sha256:bad" }],
    ["runtime build digest", { runtimeBuildDigest: "sha256:bad" }],
    ["runtime bundle digest", { runtimeBundleDigest: "sha256:bad" }],
  ])("rejects invalid image field: %s", (_name, override) => {
    expectInvalid(configuration([{ ...declaration(), ...override }]));
  });

  it.each([
    "",
    "node",
    "./node",
    "/../node",
    "/./node",
    "/usr/../node",
    "/usr/./node",
    "/usr//node",
    "/usr/node/",
    "/node\0bad",
  ])("rejects unsafe command executable %s", (executable) => {
    const image = declaration();
    image.runtime.executable = executable;
    expectInvalid(configuration([image]));
  });

  it("enforces command string, count, and aggregate UTF-8 bounds", () => {
    const exactExecutable = declaration();
    exactExecutable.runtime.executable = `/${"a".repeat(
      maximumTrustedImageCommandValueBytes - 1,
    )}`;
    exactExecutable.runtime.arguments = [];
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([exactExecutable]),
      ),
    ).not.toThrow();

    const oversizedExecutable = declaration();
    oversizedExecutable.runtime.executable = `/${"a".repeat(
      maximumTrustedImageCommandValueBytes,
    )}`;
    expectInvalid(configuration([oversizedExecutable]));

    const multibyteExecutable = declaration();
    multibyteExecutable.runtime.executable = `/${"€".repeat(1_366)}`;
    expectInvalid(configuration([multibyteExecutable]));

    const maximumCount = declaration();
    maximumCount.runtime.arguments = Array.from(
      { length: maximumTrustedImageCommandArguments },
      () => "x",
    );
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([maximumCount]),
      ),
    ).not.toThrow();
    maximumCount.runtime.arguments.push("overflow");
    expectInvalid(configuration([maximumCount]));

    const exactAggregate = declaration();
    exactAggregate.runtime.executable = "/a";
    exactAggregate.runtime.arguments = [
      ...Array.from({ length: 15 }, () => "x".repeat(4_096)),
      "x".repeat(maximumTrustedImageCommandBytes - 2 - 15 * 4_096),
    ];
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([exactAggregate]),
      ),
    ).not.toThrow();
    exactAggregate.runtime.arguments[15] += "x";
    expectInvalid(configuration([exactAggregate]));
  });

  it("rejects NUL and oversized individual command arguments", () => {
    for (const argument of [
      "private\0argument",
      "x".repeat(maximumTrustedImageCommandValueBytes + 1),
      "€".repeat(1_366),
    ]) {
      const image = declaration();
      image.profileProbe.arguments = [argument];
      expectInvalid(configuration([image]));
    }
  });

  it("enforces exact environment count, entry, and aggregate UTF-8 bounds", () => {
    const exactEntry = declaration();
    exactEntry.environment = [
      environmentEntry(0, maximumTrustedImageEnvironmentEntryBytes),
    ];
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([exactEntry]),
      ),
    ).not.toThrow();

    const oversizedEntry = declaration();
    oversizedEntry.environment = [
      environmentEntry(0, maximumTrustedImageEnvironmentEntryBytes + 1),
    ];
    expectInvalid(configuration([oversizedEntry]));

    const maximumCount = declaration();
    maximumCount.environment = Array.from(
      { length: maximumTrustedImageEnvironmentEntries },
      (_, index) => `E${index}=x`,
    );
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([maximumCount]),
      ),
    ).not.toThrow();
    maximumCount.environment.push("OVERFLOW=x");
    expectInvalid(configuration([maximumCount]));

    const exactAggregate = declaration();
    exactAggregate.environment = Array.from({ length: 32 }, (_, index) =>
      environmentEntry(index, maximumTrustedImageEnvironmentBytes / 32),
    );
    expect(() =>
      parseLocalRunnerTrustedImageCatalogConfiguration(
        configuration([exactAggregate]),
      ),
    ).not.toThrow();

    const oversizedAggregate = declaration();
    oversizedAggregate.environment = Array.from({ length: 33 }, (_, index) =>
      environmentEntry(index, maximumTrustedImageEnvironmentBytes / 32),
    );
    expectInvalid(configuration([oversizedAggregate]));
  });

  it.each([
    ["missing separator", "NAME"],
    ["lowercase name", "name=value"],
    ["duplicate name", ["NAME=first", "NAME=second"]],
    ["credential name", "API_TOKEN=private"],
    ["NUL value", "NAME=private\0value"],
    ["multibyte overflow", `NAME=${"€".repeat(2_730)}`],
  ])("rejects invalid environment: %s", (_name, entry) => {
    const image = declaration();
    image.environment = Array.isArray(entry) ? entry : [entry];
    expectInvalid(configuration([image]));
  });

  it("publishes fixed frozen errors without serializing candidate values", () => {
    const secret = "API_TOKEN=do-not-serialize";
    const error = failure(
      configuration([{ ...declaration(), environment: [secret] }]),
    );

    expect(error).toBeInstanceOf(LocalRunnerTrustedImageConfigurationError);
    expect(error).toMatchObject({
      code: "invalid_configuration",
      message: "Trusted image configuration is invalid.",
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects every property-generated non-digest", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 100 })
          .filter(
            (value) =>
              value.length > 0 && !/^sha256:[a-f0-9]{64}$/u.test(value),
          ),
        (candidateDigest) => {
          const error = failure(
            configuration([{ ...declaration(), digest: candidateDigest }]),
          );
          expect(error).toMatchObject({ code: "invalid_configuration" });
        },
      ),
      { numRuns: 200 },
    );
  });
});
