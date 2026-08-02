import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LocalRunnerConfigurationError,
  parseLocalRunnerConfiguration,
} from "./parser";

function configuration() {
  return {
    version: "1",
    identity: {
      deploymentId: "runner-prod-1",
      runnerId: "10000000-0000-4000-8000-000000000001",
    },
    controlPlane: {
      origin: "https://control.socrates.test",
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
    },
    roots: {
      artifacts: "/var/lib/socrates/artifacts",
      sources: "/var/lib/socrates/sources",
      journal: "/var/lib/socrates/journal",
      spool: "/var/lib/socrates/spool",
    },
    engine: {
      executable: "nerdctl",
      readinessTtlMs: 30_000,
      controlTimeoutMs: 10_000,
      executionTimeoutMs: 300_000,
      maximumControlOutputBytes: 262_144,
    },
    source: {
      maximumArchiveBytes: 16_777_216,
      maximumExpandedBytes: 67_108_864,
      maximumEntries: 10_000,
      maximumFileBytes: 16_777_216,
      maximumPathBytes: 4_096,
      maximumComponentBytes: 255,
      maximumPathDepth: 64,
    },
    request: { maximumBytes: 1_048_576 },
    runtime: {
      maximumProtocolBytes: 524_288,
      maximumChildOutputBytes: 2_097_152,
    },
    execution: {
      maximumWallTimeMs: 300_000,
      maximumMemoryBytes: 1_073_741_824,
      maximumPids: 128,
      maximumWritableBytes: 1_073_741_824,
      maximumRuntimeOutputBytes: 2_097_152,
      maximumCommandCount: 3,
      temporaryBytes: 67_108_864,
      sharedMemoryBytes: 67_108_864,
      cpuQuotaPeriodMicros: 100_000,
      minimumCpuQuotaMicros: 1_000,
      maximumCpuQuotaMicros: 100_000,
    },
    durability: {
      journal: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 10_000,
        maximumJournalBytes: 1_000_000_000,
      },
      spool: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 1_000,
        maximumAttempts: 10_000,
        maximumSpoolBytes: 1_000_000_000,
      },
    },
    lifecycle: {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 5_000,
      maximumRecoveryAttempts: 3,
      pollIntervalMs: 1_000,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a test record.");
  }
  return value as Record<string, unknown>;
}

function changed(path: readonly string[], value: unknown): unknown {
  const candidate: unknown = structuredClone(configuration());
  let cursor = record(candidate);
  for (const component of path.slice(0, -1)) {
    cursor = record(cursor[component]);
  }
  cursor[path.at(-1)!] = value;
  return candidate;
}

function withValues(
  entries: readonly (readonly [readonly string[], unknown])[],
): unknown {
  const candidate: unknown = structuredClone(configuration());
  for (const [path, value] of entries) {
    let cursor = record(candidate);
    for (const component of path.slice(0, -1)) {
      cursor = record(cursor[component]);
    }
    cursor[path.at(-1)!] = value;
  }
  return candidate;
}

function expectInvalid(candidate: unknown, code = "invalid_configuration") {
  expect(() => parseLocalRunnerConfiguration(candidate)).toThrow(
    expect.objectContaining({
      name: "LocalRunnerConfigurationError",
      code,
      message:
        code === "invalid_candidate"
          ? "Local runner configuration candidate is not plain data."
          : "Local runner configuration is invalid.",
    }),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

const positiveNumericPaths = [
  ["controlPlane", "timeoutMs"],
  ["controlPlane", "maximumResponseBytes"],
  ["engine", "readinessTtlMs"],
  ["engine", "controlTimeoutMs"],
  ["engine", "executionTimeoutMs"],
  ["engine", "maximumControlOutputBytes"],
  ["source", "maximumArchiveBytes"],
  ["source", "maximumExpandedBytes"],
  ["source", "maximumEntries"],
  ["source", "maximumFileBytes"],
  ["source", "maximumPathBytes"],
  ["source", "maximumComponentBytes"],
  ["source", "maximumPathDepth"],
  ["request", "maximumBytes"],
  ["runtime", "maximumProtocolBytes"],
  ["runtime", "maximumChildOutputBytes"],
  ["execution", "maximumWallTimeMs"],
  ["execution", "maximumMemoryBytes"],
  ["execution", "maximumPids"],
  ["execution", "maximumWritableBytes"],
  ["execution", "maximumRuntimeOutputBytes"],
  ["execution", "maximumCommandCount"],
  ["execution", "temporaryBytes"],
  ["execution", "sharedMemoryBytes"],
  ["execution", "cpuQuotaPeriodMicros"],
  ["execution", "minimumCpuQuotaMicros"],
  ["execution", "maximumCpuQuotaMicros"],
  ["durability", "journal", "maximumManifestBytes"],
  ["durability", "journal", "maximumClaimBytes"],
  ["durability", "journal", "maximumItems"],
  ["durability", "journal", "maximumJournalBytes"],
  ["durability", "spool", "maximumSegmentBytes"],
  ["durability", "spool", "maximumEventsPerSegment"],
  ["durability", "spool", "maximumAttempts"],
  ["durability", "spool", "maximumSpoolBytes"],
  ["lifecycle", "leaseDurationMs"],
  ["lifecycle", "heartbeatIntervalMs"],
  ["lifecycle", "pollIntervalMs"],
] as const;

describe("parseLocalRunnerConfiguration", () => {
  it("returns an exact detached deeply frozen snapshot", () => {
    const candidate = configuration();
    const parsed = parseLocalRunnerConfiguration(candidate);
    candidate.identity.deploymentId = "mutated";
    candidate.roots.artifacts = "/mutated";

    expect(parsed).toEqual(configuration());
    expect(parsed).not.toBe(candidate);
    expect(parsed.identity).not.toBe(candidate.identity);
    expectDeepFrozen(parsed);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("is deterministic while issuing independent snapshots", () => {
    const first = parseLocalRunnerConfiguration(configuration());
    const second = parseLocalRunnerConfiguration(configuration());

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.identity).not.toBe(second.identity);
  });

  it.each([
    ["array", []],
    ["date", new Date(0)],
    ["function", { version: () => "1" }],
    [
      "accessor",
      Object.defineProperty({}, "version", {
        enumerable: true,
        get: () => {
          throw new Error("private getter value");
        },
      }),
    ],
    [
      "throwing proxy",
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("private proxy value");
          },
        },
      ),
    ],
    ["non-enumerable", Object.defineProperty({}, "version", { value: "1" })],
    ["symbol key", { [Symbol("secret")]: "value" }],
  ])("rejects a non-data %s without leaking values", (_name, candidate) => {
    const error = (() => {
      try {
        parseLocalRunnerConfiguration(candidate);
      } catch (cause) {
        return cause;
      }
      throw new Error("Expected parser failure.");
    })();

    expect(error).toMatchObject({ code: "invalid_candidate" });
    expect(String(error)).not.toContain("private");
  });

  it("rejects cyclic candidates", () => {
    const candidate: Record<string, unknown> = {};
    candidate["self"] = candidate;
    expectInvalid(candidate, "invalid_candidate");
  });

  it.each([null, true, 1, "configuration"])(
    "rejects primitive candidate %#",
    (candidate) => expectInvalid(candidate),
  );

  it("rejects undefined as a non-data candidate", () => {
    expectInvalid(undefined, "invalid_candidate");
  });

  it("rejects unknown keys at every object level", () => {
    const paths = [
      [],
      ["identity"],
      ["controlPlane"],
      ["roots"],
      ["engine"],
      ["source"],
      ["request"],
      ["runtime"],
      ["execution"],
      ["durability"],
      ["durability", "journal"],
      ["durability", "spool"],
      ["lifecycle"],
    ] as const;
    for (const path of paths) {
      const candidate: unknown = structuredClone(configuration());
      let cursor = record(candidate);
      for (const component of path) cursor = record(cursor[component]);
      cursor["unexpected"] = true;
      expectInvalid(candidate);
    }
  });

  it("rejects missing keys at every object level", () => {
    const paths = [
      ["version"],
      ["identity", "runnerId"],
      ["controlPlane", "origin"],
      ["roots", "artifacts"],
      ["engine", "executable"],
      ["source", "maximumArchiveBytes"],
      ["request", "maximumBytes"],
      ["runtime", "maximumProtocolBytes"],
      ["execution", "maximumWallTimeMs"],
      ["durability", "journal"],
      ["durability", "journal", "maximumManifestBytes"],
      ["durability", "spool", "maximumSegmentBytes"],
      ["lifecycle", "leaseDurationMs"],
    ] as const;
    for (const path of paths) {
      const candidate: unknown = structuredClone(configuration());
      let cursor = record(candidate);
      for (const component of path.slice(0, -1)) {
        cursor = record(cursor[component]);
      }
      delete cursor[path.at(-1)!];
      expectInvalid(candidate);
    }
  });

  it.each(["credential", "token", "environment", "signal", "clock"])(
    "rejects forbidden process authority %s",
    (field) => {
      const candidate = configuration() as Record<string, unknown>;
      candidate[field] = "private-value";
      const error = (() => {
        try {
          parseLocalRunnerConfiguration(candidate);
        } catch (cause) {
          return cause;
        }
        throw new Error("Expected parser failure.");
      })();
      expect(error).toMatchObject({ code: "invalid_configuration" });
      expect(String(error)).not.toContain("private-value");
    },
  );

  it.each([
    [["version"], "2"],
    [["identity", "deploymentId"], "Upper_Case"],
    [["identity", "deploymentId"], "runner-"],
    [["identity", "runnerId"], "not-a-uuid"],
    [["engine", "executable"], ""],
    [["engine", "executable"], " nerdctl"],
    [["engine", "executable"], "nerdctl\0evil"],
    [["engine", "executable"], "n".repeat(4_097)],
  ] as const)("rejects malformed scalar at %j", (path, value) => {
    expectInvalid(changed(path, value));
  });

  it.each([
    "http://control.socrates.test",
    "https://user@control.socrates.test",
    "https://control.socrates.test/path",
    "https://control.socrates.test?query=1",
    "https://control.socrates.test#fragment",
    "https://control.socrates.test/.",
    "https://control.socrates.test/%2e",
    "https://control.socrates.test:443",
    "not a url",
    `https://${"a".repeat(2_048)}.test`,
  ])("rejects ambiguous or non-HTTPS origin %s", (origin) => {
    expectInvalid(changed(["controlPlane", "origin"], origin));
  });

  it.each([
    "relative/root",
    "/",
    "/var/lib/../private",
    "/var//lib/socrates",
    "/var/lib/socrates/",
    "/var/lib/socrates\0private",
    "/var/lib/socrates,private",
    `/var/lib/${"a".repeat(4_097)}`,
    "/var/lib/cafe\u0301",
  ])("rejects non-canonical root %s", (root) => {
    expectInvalid(changed(["roots", "artifacts"], root));
  });

  it.each([
    "/var/lib/socrates/sources",
    "/var/lib/socrates",
    "/var/lib/socrates/sources/nested",
  ])("rejects overlapping root %s", (root) => {
    expectInvalid(changed(["roots", "artifacts"], root));
  });

  it("rejects every invalid positive numeric authority", () => {
    for (const path of positiveNumericPaths) {
      for (const invalid of [
        0,
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        2 ** 51,
      ]) {
        expectInvalid(changed(path, invalid));
      }
    }
  });

  it.each([
    [["lifecycle", "revocationGracePeriodMs"], -1],
    [["lifecycle", "revocationGracePeriodMs"], 0.5],
    [["lifecycle", "maximumRecoveryAttempts"], -1],
    [["lifecycle", "maximumRecoveryAttempts"], 101],
    [["lifecycle", "maximumRecoveryAttempts"], 0.5],
  ] as const)("rejects invalid bounded numeric authority %j", (path, value) => {
    expectInvalid(changed(path, value));
  });

  it.each([
    ["heartbeat equality", [["lifecycle", "heartbeatIntervalMs"], 30_000]],
    ["heartbeat overflow", [["lifecycle", "heartbeatIntervalMs"], 30_001]],
    ["revocation overflow", [["lifecycle", "revocationGracePeriodMs"], 30_001]],
    ["source file overflow", [["source", "maximumFileBytes"], 67_108_865]],
    ["source component overflow", [["source", "maximumComponentBytes"], 4_097]],
    ["protocol overflow", [["runtime", "maximumProtocolBytes"], 2_097_153]],
    [
      "child output overflow",
      [["runtime", "maximumChildOutputBytes"], 2_097_153],
    ],
    [
      "journal manifest overflow",
      [["durability", "journal", "maximumManifestBytes"], 1_000_000_001],
    ],
    [
      "journal claim overflow",
      [["durability", "journal", "maximumClaimBytes"], 1_000_000_001],
    ],
    [
      "spool segment overflow",
      [["durability", "spool", "maximumSegmentBytes"], 1_000_000_001],
    ],
    ["engine timeout underflow", [["engine", "executionTimeoutMs"], 299_999]],
    ["CPU quota inversion", [["execution", "minimumCpuQuotaMicros"], 100_001]],
    ["CPU period shape", [["execution", "cpuQuotaPeriodMicros"], 99_999]],
  ] as const)("rejects relational %s", (_name, entry) => {
    expectInvalid(changed(entry[0], entry[1]));
  });

  it("rejects writable reservation equality and overflow", () => {
    expectInvalid(
      withValues([[["execution", "maximumWritableBytes"], 134_217_728]]),
    );
    expectInvalid(
      withValues([[["execution", "maximumWritableBytes"], 134_217_727]]),
    );
  });

  it("accepts every exact relational boundary", () => {
    const candidate = withValues([
      [["lifecycle", "heartbeatIntervalMs"], 29_999],
      [["lifecycle", "revocationGracePeriodMs"], 30_000],
      [["source", "maximumFileBytes"], 67_108_864],
      [["source", "maximumComponentBytes"], 4_096],
      [["runtime", "maximumProtocolBytes"], 2_097_152],
      [["runtime", "maximumChildOutputBytes"], 2_097_152],
      [["durability", "journal", "maximumManifestBytes"], 1_000_000_000],
      [["durability", "journal", "maximumClaimBytes"], 1_000_000_000],
      [["durability", "spool", "maximumSegmentBytes"], 1_000_000_000],
      [["engine", "executionTimeoutMs"], 300_000],
      [["execution", "minimumCpuQuotaMicros"], 100_000],
      [["execution", "maximumWritableBytes"], 134_217_729],
    ]);

    expect(parseLocalRunnerConfiguration(candidate)).toMatchObject(candidate);
  });

  it("enforces lifecycle relations across generated one-unit boundaries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 86_400_000 }),
        (leaseDurationMs) => {
          expect(
            parseLocalRunnerConfiguration(
              withValues([
                [["lifecycle", "leaseDurationMs"], leaseDurationMs],
                [["lifecycle", "heartbeatIntervalMs"], leaseDurationMs - 1],
                [["lifecycle", "revocationGracePeriodMs"], leaseDurationMs],
              ]),
            ).lifecycle,
          ).toMatchObject({
            leaseDurationMs,
            heartbeatIntervalMs: leaseDurationMs - 1,
            revocationGracePeriodMs: leaseDurationMs,
          });
          expectInvalid(
            withValues([
              [["lifecycle", "leaseDurationMs"], leaseDurationMs],
              [["lifecycle", "heartbeatIntervalMs"], leaseDurationMs],
            ]),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("uses a fixed public error while retaining typed diagnostic cause", () => {
    const error = (() => {
      try {
        parseLocalRunnerConfiguration({
          ...configuration(),
          credential: "secret-token-value",
        });
      } catch (cause) {
        return cause;
      }
      throw new Error("Expected parser failure.");
    })();

    expect(error).toBeInstanceOf(LocalRunnerConfigurationError);
    expect(error).toMatchObject({ code: "invalid_configuration" });
    expect(error).toHaveProperty("cause");
    expect(String(error)).not.toContain("secret-token-value");
    expect(JSON.stringify((error as Error).cause)).not.toContain(
      "secret-token-value",
    );
  });
});
