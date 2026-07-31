import { describe, expect, it } from "vitest";

import {
  NerdctlImageInspector,
  parseSandboxImageInspection,
  SandboxImageInspectionError,
} from "./inspection";
import { successfulResult } from "../oci/test-fixtures";

import type {
  ProcessExecutor,
  ProcessRequest,
  ProcessResult,
} from "../oci/process";

const manifestDigest = `sha256:${"a".repeat(64)}`;
const configurationDigest = `sha256:${"b".repeat(64)}`;
const reference = `registry.example/socrates/task-runtime@${manifestDigest}`;
const environment = [
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=22.23.1",
];
const labels = {
  "io.socrates.task-runtime.abi": "socrates.task-runtime.v1",
  "io.socrates.task-runtime.build-digest": `sha256:${"c".repeat(64)}`,
  "io.socrates.task-runtime.bundle-digest": `sha256:${"d".repeat(64)}`,
};

function compatible(overrides: Record<string, unknown> = {}): ProcessResult {
  return successfulResult(
    JSON.stringify({
      Id: configurationDigest,
      RepoDigests: [reference],
      Os: "linux",
      Architecture: "amd64",
      Config: {
        User: "65534:65534",
        Env: environment,
        Entrypoint: ["/usr/local/bin/node", "/opt/socrates/task-runtime.mjs"],
        Cmd: [],
        Labels: labels,
        Volumes: null,
        Healthcheck: null,
        WorkingDir: "",
        StopSignal: "",
      },
      ...overrides,
    }),
  );
}

function native(overrides: Record<string, unknown> = {}): ProcessResult {
  return successfulResult(
    JSON.stringify({
      Image: {
        Name: reference,
        Target: {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: 1_024,
        },
      },
      ...overrides,
    }),
  );
}

class FakeProcessExecutor implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];
  readonly #results: ProcessResult[];

  constructor(results: ProcessResult[]) {
    this.#results = [...results];
  }

  async run(input: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(input);
    const result = this.#results.shift();
    if (!result) throw new Error("Unexpected inspection call.");
    return result;
  }
}

describe("sandbox image inspection", () => {
  it("parses exact local OCI identity and security-relevant configuration", () => {
    expect(
      parseSandboxImageInspection({
        reference,
        architecture: "amd64",
        dockerCompatible: compatible(),
        native: native(),
      }),
    ).toEqual({
      reference,
      manifestDigest,
      manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
      configurationDigest,
      platform: "linux",
      architecture: "amd64",
      user: "65534:65534",
      environment,
      entrypoint: ["/usr/local/bin/node", "/opt/socrates/task-runtime.mjs"],
      command: [],
      labels,
      workingDirectory: "",
      stopSignal: "",
    });
  });

  it.each([
    ["platform", compatible({ Architecture: "arm64" }), native(), "platform"],
    [
      "reference",
      compatible(),
      native({
        Image: {
          Name: `registry.example/other@${manifestDigest}`,
          Target: {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: manifestDigest,
          },
        },
      }),
      "target",
    ],
    [
      "media type",
      compatible(),
      native({
        Image: {
          Name: reference,
          Target: {
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: manifestDigest,
          },
        },
      }),
      "media type",
    ],
    [
      "volume",
      compatible({
        Config: {
          User: "65534:65534",
          Env: environment,
          Entrypoint: ["/usr/local/bin/node"],
          Cmd: [],
          Labels: labels,
          Volumes: { "/data": {} },
        },
      }),
      native(),
      "Volumes",
    ],
  ])("rejects %s drift", (_name, dockerCompatible, nativeResult, message) => {
    expect(() =>
      parseSandboxImageInspection({
        reference,
        architecture: "amd64",
        dockerCompatible,
        native: nativeResult,
      }),
    ).toThrowError(message);
  });

  it("uses only bounded, platform-specific local image inspection calls", async () => {
    const processes = new FakeProcessExecutor([compatible(), native()]);
    const inspection = await new NerdctlImageInspector(processes).inspect({
      reference,
      architecture: "amd64",
    });

    expect(inspection.manifestDigest).toBe(manifestDigest);
    expect(processes.requests).toHaveLength(2);
    expect(processes.requests.map((request) => request.arguments)).toEqual([
      [
        "image",
        "inspect",
        "--platform",
        "linux/amd64",
        "--format",
        "{{json .}}",
        "--mode",
        "dockercompat",
        reference,
      ],
      [
        "image",
        "inspect",
        "--platform",
        "linux/amd64",
        "--format",
        "{{json .}}",
        "--mode",
        "native",
        reference,
      ],
    ]);
    expect(
      processes.requests.flatMap((request) => request.arguments),
    ).not.toContain("pull");
  });

  it("rejects stderr and non-zero inspection outcomes without leaking output", () => {
    expect(() =>
      parseSandboxImageInspection({
        reference,
        architecture: "amd64",
        dockerCompatible: compatible({}),
        native: successfulResult("secret", {
          exitCode: 1,
          stderr: "registry credential",
        }),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SandboxImageInspectionError>>({
        code: "engine",
        message: "Local native image inspection failed.",
      }),
    );
  });
});
