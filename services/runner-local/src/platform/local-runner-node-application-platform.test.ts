import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeDirectorySync } from "../durability";
import {
  NodeHostReadinessInspector,
  NodeProcessExecutor,
  type ProcessRequest,
  type ProcessResult,
} from "../oci";
import {
  fixtureHostReadinessProbe,
  fixtureNerdctlCommand,
  successfulResult,
} from "../oci/test-fixtures";
import { NodeLeaseAuthorityScheduler } from "../supervision";
import {
  LocalRunnerNodeApplicationPlatform,
  LocalRunnerNodeApplicationPlatformError,
  type LocalRunnerNodeApplicationPlatformOptions,
} from "./local-runner-node-application-platform";
import {
  fixtureApplicationConfiguration,
  fixtureCredential,
  fixtureTrustedImages,
} from "./test-fixtures";

const hostConstructions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

vi.mock("../oci", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oci")>();
  class CapturedNodeHostReadinessInspector
    extends actual.NodeHostReadinessInspector
  {
    constructor(
      options: ConstructorParameters<
        typeof actual.NodeHostReadinessInspector
      >[0],
    ) {
      super(options);
      hostConstructions.push({ ...options });
    }
  }
  return {
    ...actual,
    NodeHostReadinessInspector: CapturedNodeHostReadinessInspector,
  };
});

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  hostConstructions.splice(0);
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "socrates-node-platform-"));
  roots.push(value);
  return value;
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return true;
    }
    throw cause;
  }
}

function options(parent = "/var/lib/socrates") {
  return {
    configuration: fixtureApplicationConfiguration(parent),
    trustedImages: fixtureTrustedImages(),
    credential: fixtureCredential,
    fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    observer: { observe: vi.fn(async () => undefined) },
  } satisfies LocalRunnerNodeApplicationPlatformOptions;
}

function failure(candidate: unknown): LocalRunnerNodeApplicationPlatformError {
  try {
    new LocalRunnerNodeApplicationPlatform(
      candidate as LocalRunnerNodeApplicationPlatformOptions,
    );
  } catch (cause) {
    if (cause instanceof LocalRunnerNodeApplicationPlatformError) return cause;
    throw cause;
  }
  throw new Error("Expected Node platform construction to fail.");
}

function nodeProcessResult(request: ProcessRequest): ProcessResult {
  const command = fixtureNerdctlCommand(request);
  if (command === "version") {
    return successfulResult(
      JSON.stringify({
        Client: { Version: "2.3.1" },
        Server: { Version: "2.1.4" },
      }),
    );
  }
  if (command === "info") {
    return successfulResult(
      JSON.stringify({
        SecurityOptions: ["name=rootless", "name=seccomp"],
        Architecture: "amd64",
        CgroupVersion: "2",
      }),
    );
  }
  if (command === "inspect" && request.arguments.includes("--help")) {
    return successfulResult("--mode native");
  }
  if (command === "ps") return successfulResult();
  throw new Error(`Unexpected Node platform command ${String(command)}.`);
}

describe("local runner Node application platform", () => {
  it("rejects configuration before reading any later owner", () => {
    const reads: PropertyKey[] = [];
    const candidate = new Proxy(
      { configuration: { private: "invalid configuration" } },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (property === "configuration") {
            return Reflect.get(target, property, receiver);
          }
          throw new Error("private later owner");
        },
      },
    );

    expect(failure(candidate)).toMatchObject({
      code: "invalid_configuration",
      message: "Local runner Node configuration is invalid.",
    });
    expect(reads).toEqual(["configuration"]);
  });

  it("constructs one frozen opaque platform without effects", async () => {
    const parent = await root();
    const value = options(parent);
    const process = vi.spyOn(NodeProcessExecutor.prototype, "run");
    const host = vi.spyOn(NodeHostReadinessInspector.prototype, "inspect");
    const wait = vi.spyOn(NodeLeaseAuthorityScheduler.prototype, "wait");
    const sync = vi.spyOn(NodeDirectorySync.prototype, "sync");
    const now = vi.spyOn(Date, "now");
    const platform = new LocalRunnerNodeApplicationPlatform(value);

    expect(Object.isFrozen(platform)).toBe(true);
    expect(Object.keys(platform)).toEqual([]);
    expect(JSON.stringify(platform)).toBe("{}");
    expect(hostConstructions).toEqual([
      {
        configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
        xdgRuntimeDirectory: "/run/user/1001",
        workingDirectory: "/home/socrates/.local/state/socrates/runner",
      },
    ]);
    for (const effect of [
      process,
      host,
      wait,
      sync,
      now,
      value.fetch,
      value.observer.observe,
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
    for (const path of Object.values(value.configuration.roots)) {
      await expect(absent(path)).resolves.toBe(true);
    }
  });

  it("reads all five owners and the observer method exactly once", () => {
    const value = options();
    const reads = new Map<PropertyKey, number>();
    let observerMethodReads = 0;
    const observe = value.observer.observe;
    Object.defineProperty(value.observer, "observe", {
      configurable: true,
      get: () => {
        observerMethodReads += 1;
        return observe;
      },
    });
    const candidate = new Proxy(value, {
      get(target, property, receiver) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });

    new LocalRunnerNodeApplicationPlatform(candidate);

    expect(Object.fromEntries(reads)).toEqual({
      configuration: 1,
      credential: 1,
      fetch: 1,
      observer: 1,
      trustedImages: 1,
    });
    expect(observerMethodReads).toBe(1);
    expect(value.fetch).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not consult ambient global fetch", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let ambientReads = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get: () => {
        ambientReads += 1;
        throw new Error("ambient fetch authority");
      },
    });
    try {
      const explicitFetch = vi.fn(async () => new Response(null));
      new LocalRunnerNodeApplicationPlatform({
        ...options(),
        fetch: explicitFetch,
      });
      expect(ambientReads).toBe(0);
      expect(explicitFetch).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, "fetch", original);
    }
  });

  it.each([
    ["invalid_images", { trustedImages: { private: "image-secret" } }],
    ["invalid_credential", { credential: "credential-secret" }],
    ["invalid_capability", { fetch: "fetch-secret" }],
    ["invalid_capability", { observer: { observe: "observer-secret" } }],
  ])("returns a cause-free redacted %s failure", (code, override) => {
    const error = failure({ ...options(), ...override });
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(error.code).toBe(code);
    expect("cause" in error).toBe(false);
    expect(rendered).not.toMatch(
      /image-secret|credential-secret|fetch-secret|observer-secret/u,
    );
  });

  it("normalizes a throwing later-owner read without exposing its cause", () => {
    const value = options();
    const candidate = Object.defineProperty({ ...value }, "trustedImages", {
      enumerable: true,
      get: () => {
        throw new Error("private input cause");
      },
    });
    const error = failure(candidate);

    expect(error).toMatchObject({
      code: "invalid_input",
      message: "Local runner Node platform input is invalid.",
    });
    expect("cause" in error).toBe(false);
    expect(JSON.stringify(error)).not.toContain("private input cause");
  });

  it("normalizes Node adapter construction failure without its cause", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Date, "now");
    Object.defineProperty(Date, "now", {
      configurable: true,
      get: () => {
        throw new Error("private adapter cause");
      },
    });
    try {
      const error = failure(options());
      expect(error).toMatchObject({
        code: "adapter_composition_failed",
        message: "Local runner Node adapter composition failed.",
      });
      expect("cause" in error).toBe(false);
      expect(JSON.stringify(error)).not.toContain("private adapter cause");
    } finally {
      if (descriptor) Object.defineProperty(Date, "now", descriptor);
    }
  });

  it("captures inputs and runs one idle lifecycle through its Node adapters", async () => {
    const parent = await root();
    const value = options(parent);
    const requests: ProcessRequest[] = [];
    vi.spyOn(NodeProcessExecutor.prototype, "run").mockImplementation(
      async (request) => {
        requests.push(request);
        return nodeProcessResult(request);
      },
    );
    vi.spyOn(NodeHostReadinessInspector.prototype, "inspect").mockResolvedValue(
      { ...fixtureHostReadinessProbe },
    );
    const controller = new AbortController();
    const fetchImplementation = value.fetch;
    const observe = value.observer.observe;
    value.observer.observe = vi.fn(async (result) => {
      await observe(result);
      if (result.state === "idle") {
        controller.abort(Symbol("Node platform idle stop"));
      }
    });
    const platform = new LocalRunnerNodeApplicationPlatform(value);
    value.configuration.identity.deploymentId = "mutated-deployment";
    value.trustedImages.images[0]!.digest = `sha256:${"f".repeat(64)}`;
    value.fetch = vi.fn(async () => {
      throw new Error("mutated fetch");
    });
    value.observer.observe = vi.fn(async () => {
      throw new Error("mutated observer");
    });

    const first = platform.run(controller.signal);
    const second = platform.run(controller.signal);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ state: "stopped" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith({ state: "idle" });
    expect(requests.map(fixtureNerdctlCommand)).toEqual(["ps"]);
    for (const request of requests) {
      expect(request.executable).toBe("/usr/local/bin/nerdctl");
      expect(request.workingDirectory).toBe(
        "/home/socrates/.local/state/socrates/runner",
      );
      expect(request.environment).toEqual({
        HOME: "/home/socrates",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        XDG_CONFIG_HOME: "/home/socrates/.config/socrates",
        XDG_DATA_HOME: "/home/socrates/.local/share/socrates",
        XDG_RUNTIME_DIR: "/run/user/1001",
        DOCKER_CONFIG: "/home/socrates/.config/socrates/docker",
        NERDCTL_TOML: "/etc/socrates/runner-local/nerdctl.toml",
      });
      expect(request.arguments).toContain(
        "--namespace=socrates-runner-application-1",
      );
    }
  });

  it("stops a pre-aborted run without invoking any adapter", async () => {
    const value = options();
    const process = vi.spyOn(NodeProcessExecutor.prototype, "run");
    const host = vi.spyOn(NodeHostReadinessInspector.prototype, "inspect");
    const wait = vi.spyOn(NodeLeaseAuthorityScheduler.prototype, "wait");
    const sync = vi.spyOn(NodeDirectorySync.prototype, "sync");
    const platform = new LocalRunnerNodeApplicationPlatform(value);
    const controller = new AbortController();
    controller.abort(Object.freeze({ private: "shutdown authority" }));

    await expect(platform.run(controller.signal)).resolves.toEqual({
      state: "stopped",
    });
    for (const effect of [
      process,
      host,
      wait,
      sync,
      value.fetch,
      value.observer.observe,
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });
});
