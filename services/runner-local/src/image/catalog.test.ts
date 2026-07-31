import { runtimeAbi } from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import { assertAdmittedImage } from "./capability";
import { SandboxImageCatalog, SandboxImageCatalogError } from "./catalog";

import type {
  SandboxImageHandshakeVerifier,
  SandboxImageInspector,
  TrustedSandboxImage,
} from "./catalog";
import type { SandboxImageInspection } from "./inspection";

const manifestDigest = `sha256:${"a".repeat(64)}`;
const configurationDigest = `sha256:${"b".repeat(64)}`;
const runtimeBuildDigest = `sha256:${"c".repeat(64)}`;
const runtimeBundleDigest = `sha256:${"d".repeat(64)}`;
const reference = `registry.example/socrates/task-runtime@${manifestDigest}`;

function declaration(
  overrides: Partial<TrustedSandboxImage> = {},
): TrustedSandboxImage {
  return {
    reference,
    manifestDigest,
    manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
    configurationDigest,
    architecture: "amd64",
    runtimeBuildDigest,
    runtimeBundleDigest,
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
    ...overrides,
  };
}

function inspection(
  overrides: Partial<SandboxImageInspection> = {},
): SandboxImageInspection {
  return {
    reference,
    manifestDigest,
    manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
    configurationDigest,
    platform: "linux",
    architecture: "amd64",
    user: "65534:65534",
    environment: [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=22.23.1",
    ],
    entrypoint: ["/usr/local/bin/node", "/opt/socrates/task-runtime.mjs"],
    command: [],
    labels: {
      "io.socrates.task-runtime.abi": runtimeAbi,
      "io.socrates.task-runtime.build-digest": runtimeBuildDigest,
      "io.socrates.task-runtime.bundle-digest": runtimeBundleDigest,
    },
    workingDirectory: "",
    stopSignal: "",
    ...overrides,
  };
}

class FakeInspector implements SandboxImageInspector {
  calls = 0;

  constructor(readonly observed: SandboxImageInspection) {}

  async inspect() {
    this.calls += 1;
    return this.observed;
  }
}

class FakeHandshake implements SandboxImageHandshakeVerifier {
  calls: Parameters<SandboxImageHandshakeVerifier["verify"]>[0][] = [];

  constructor(
    readonly observed: Readonly<{ abi: string; buildDigest: string }> = {
      abi: runtimeAbi,
      buildDigest: runtimeBuildDigest,
    },
  ) {}

  async verify(input: Parameters<SandboxImageHandshakeVerifier["verify"]>[0]) {
    this.calls.push(input);
    return this.observed;
  }
}

describe("trusted sandbox image catalog", () => {
  it("admits a configured digest only after inspection and live handshake", async () => {
    const inspector = new FakeInspector(inspection());
    const handshake = new FakeHandshake();
    const catalog = new SandboxImageCatalog(
      [declaration()],
      inspector,
      handshake,
    );

    const first = catalog.admit(manifestDigest, "amd64");
    const second = catalog.admit(manifestDigest, "amd64");
    expect(second).toBe(first);
    const image = await first;

    expect(inspector.calls).toBe(1);
    expect(handshake.calls).toHaveLength(1);
    expect(handshake.calls[0]?.runtime).toEqual({
      executable: "/usr/local/bin/node",
      arguments: ["/opt/socrates/task-runtime.mjs", "--handshake"],
    });
    expect(image.runtime.arguments).toEqual(["/opt/socrates/task-runtime.mjs"]);
    expect(() => assertAdmittedImage(image)).not.toThrow();
  });

  it("does not inspect a caller-selected reference for an unknown digest", async () => {
    const inspector = new FakeInspector(inspection());
    const handshake = new FakeHandshake();
    const catalog = new SandboxImageCatalog(
      [declaration()],
      inspector,
      handshake,
    );

    await expect(
      catalog.admit(`sha256:${"e".repeat(64)}`, "amd64"),
    ).rejects.toMatchObject<Partial<SandboxImageCatalogError>>({
      code: "not_configured",
    });
    expect(inspector.calls).toBe(0);
    expect(handshake.calls).toHaveLength(0);
  });

  it("rejects configuration drift before handshake", async () => {
    const inspector = new FakeInspector(
      inspection({ entrypoint: ["/bin/sh"] }),
    );
    const handshake = new FakeHandshake();
    const catalog = new SandboxImageCatalog(
      [declaration()],
      inspector,
      handshake,
    );

    await expect(catalog.admit(manifestDigest, "amd64")).rejects.toMatchObject<
      Partial<SandboxImageCatalogError>
    >({
      code: "inspection",
    });
    expect(handshake.calls).toHaveLength(0);
  });

  it("rejects a live handshake that disagrees with the pinned build", async () => {
    const catalog = new SandboxImageCatalog(
      [declaration()],
      new FakeInspector(inspection()),
      new FakeHandshake({
        abi: runtimeAbi,
        buildDigest: `sha256:${"f".repeat(64)}`,
      }),
    );

    await expect(catalog.admit(manifestDigest, "amd64")).rejects.toMatchObject<
      Partial<SandboxImageCatalogError>
    >({
      code: "handshake",
    });
  });

  it.each([
    ["duplicate", [declaration(), declaration()]],
    [
      "credential environment",
      [declaration({ environment: ["API_TOKEN=secret"] })],
    ],
    [
      "mutable reference",
      [
        declaration({
          reference: "registry.example/socrates/task-runtime:latest",
        }),
      ],
    ],
  ])("rejects invalid trusted configuration: %s", (_name, images) => {
    expect(
      () =>
        new SandboxImageCatalog(
          images,
          new FakeInspector(inspection()),
          new FakeHandshake(),
        ),
    ).toThrowError(
      expect.objectContaining<Partial<SandboxImageCatalogError>>({
        code: "configuration",
      }),
    );
  });

  it("rejects a structural capability lookalike", () => {
    const forged = {
      reference,
      digest: manifestDigest,
      architecture: "amd64" as const,
      runtime: declaration().runtime,
      profileProbe: declaration().profileProbe,
    };
    expect(() => assertAdmittedImage(forged)).toThrowError(/not admitted/u);
  });
});
