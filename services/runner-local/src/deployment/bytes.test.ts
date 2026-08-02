import { canonicalJson } from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import {
  fixtureApplicationConfiguration,
  fixtureCredential,
  fixtureTrustedImages,
} from "../platform/test-fixtures";
import {
  localRunnerCredentialBytes,
  LocalRunnerDeploymentBytesError,
  maximumLocalRunnerConfigurationBytes,
  maximumLocalRunnerTrustedImageBytes,
  parseLocalRunnerDeploymentBytes,
  type LocalRunnerDeploymentBytesErrorCode,
  type LocalRunnerDeploymentInputName,
} from "./bytes";

const encoder = new TextEncoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function validBytes() {
  return {
    configuration: bytes(fixtureApplicationConfiguration()),
    trustedImages: bytes(fixtureTrustedImages()),
    credential: encoder.encode(fixtureCredential),
  };
}

function expectFailure(
  operation: () => unknown,
  input: LocalRunnerDeploymentInputName,
  code: LocalRunnerDeploymentBytesErrorCode,
): LocalRunnerDeploymentBytesError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalRunnerDeploymentBytesError);
    const admitted = error as LocalRunnerDeploymentBytesError;
    expect(admitted).toMatchObject({ input, code });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect("cause" in admitted).toBe(false);
    return admitted;
  }
  throw new Error("Expected deployment byte admission to fail.");
}

function withConfiguration(configuration: Uint8Array) {
  return { ...validBytes(), configuration };
}

function withTrustedImages(trustedImages: Uint8Array) {
  return { ...validBytes(), trustedImages };
}

describe("parseLocalRunnerDeploymentBytes", () => {
  it("returns one frozen detached semantic snapshot", () => {
    const input = validBytes();
    const parsed = parseLocalRunnerDeploymentBytes(input);

    expect(parsed).toEqual({
      configuration: fixtureApplicationConfiguration(),
      trustedImages: fixtureTrustedImages(),
      credential: fixtureCredential,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.configuration)).toBe(true);
    expect(Object.isFrozen(parsed.configuration.engine.environment)).toBe(true);
    expect(Object.isFrozen(parsed.trustedImages)).toBe(true);
    expect(Object.isFrozen(parsed.trustedImages.images)).toBe(true);

    input.configuration.fill(0);
    input.trustedImages.fill(0);
    input.credential.fill(0);
    expect(parsed.configuration.version).toBe("1");
    expect(parsed.trustedImages.version).toBe("1");
    expect(parsed.credential).toBe(fixtureCredential);
  });

  it("reads the three owner properties exactly once in failure order", () => {
    const values = validBytes();
    const reads = { configuration: 0, trustedImages: 0, credential: 0 };
    const owner = {
      get configuration() {
        reads.configuration += 1;
        return values.configuration;
      },
      get trustedImages() {
        reads.trustedImages += 1;
        return values.trustedImages;
      },
      get credential() {
        reads.credential += 1;
        return values.credential;
      },
    };

    parseLocalRunnerDeploymentBytes(owner);
    expect(reads).toEqual({
      configuration: 1,
      trustedImages: 1,
      credential: 1,
    });

    reads.configuration = 0;
    reads.trustedImages = 0;
    reads.credential = 0;
    Object.defineProperty(owner, "configuration", {
      configurable: true,
      enumerable: true,
      get() {
        reads.configuration += 1;
        return new Uint8Array();
      },
    });
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(owner),
      "configuration",
      "invalid_size",
    );
    expect(reads).toEqual({
      configuration: 1,
      trustedImages: 0,
      credential: 0,
    });

    reads.configuration = 0;
    reads.trustedImages = 0;
    Object.defineProperty(owner, "configuration", {
      configurable: true,
      enumerable: true,
      get() {
        reads.configuration += 1;
        return values.configuration;
      },
    });
    Object.defineProperty(owner, "trustedImages", {
      configurable: true,
      enumerable: true,
      get() {
        reads.trustedImages += 1;
        return new Uint8Array();
      },
    });
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(owner),
      "trusted_images",
      "invalid_size",
    );
    expect(reads).toEqual({
      configuration: 1,
      trustedImages: 1,
      credential: 0,
    });
  });

  it("requires one exact plain owner without invoking later values", () => {
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(null),
      "configuration",
      "invalid_owner",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes({
          ...validBytes(),
          unexpected: new Uint8Array([1]),
        }),
      "configuration",
      "invalid_owner",
    );
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(Object.create(null)),
      "configuration",
      "invalid_owner",
    );
  });

  it("accepts Buffer and copies subarray views without retaining their storage", () => {
    const source = validBytes();
    const configurationBacking = new Uint8Array(
      source.configuration.length + 2,
    );
    configurationBacking.set(source.configuration, 1);
    const configuration = configurationBacking.subarray(1, -1);
    const credential = Buffer.from(source.credential);

    const parsed = parseLocalRunnerDeploymentBytes({
      configuration,
      trustedImages: source.trustedImages,
      credential,
    });
    configurationBacking.fill(0);
    credential.fill(0);

    expect(parsed.configuration.version).toBe("1");
    expect(parsed.credential).toBe(fixtureCredential);
  });

  it("enforces configuration byte limits before decoding", () => {
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(withConfiguration(new Uint8Array())),
      "configuration",
      "invalid_size",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withConfiguration(
            new Uint8Array(maximumLocalRunnerConfigurationBytes),
          ),
        ),
      "configuration",
      "invalid_utf8",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withConfiguration(
            new Uint8Array(maximumLocalRunnerConfigurationBytes + 1),
          ),
        ),
      "configuration",
      "invalid_size",
    );
  });

  it("enforces trusted-image byte limits before decoding", () => {
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(withTrustedImages(new Uint8Array())),
      "trusted_images",
      "invalid_size",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withTrustedImages(
            new Uint8Array(maximumLocalRunnerTrustedImageBytes),
          ),
        ),
      "trusted_images",
      "invalid_utf8",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withTrustedImages(
            new Uint8Array(maximumLocalRunnerTrustedImageBytes + 1),
          ),
        ),
      "trusted_images",
      "invalid_size",
    );
  });

  it.each([
    [new Uint8Array([0xff]), "invalid_utf8"],
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "invalid_utf8"],
    [encoder.encode('{"version":\u0000"1"}'), "invalid_utf8"],
    [encoder.encode("{"), "invalid_json"],
    [encoder.encode("{}"), "invalid_configuration"],
  ] as const)(
    "closes configuration decode and semantic failures",
    (value, code) => {
      expectFailure(
        () => parseLocalRunnerDeploymentBytes(withConfiguration(value)),
        "configuration",
        code,
      );
    },
  );

  it("rejects every non-canonical JSON representation after semantic admission", () => {
    const canonical = canonicalJson(fixtureApplicationConfiguration());
    const alternatives = [
      ` ${canonical}`,
      `${canonical}\n`,
      `${canonical.slice(0, -1)},"version":"1"}`,
      canonical.replace("runner-application-1", "runner-application-\\u0031"),
      canonical.replace("1048576", "1.048576e6"),
      JSON.stringify({ version: "1", ...fixtureApplicationConfiguration() }),
    ];

    for (const alternative of alternatives) {
      expectFailure(
        () =>
          parseLocalRunnerDeploymentBytes(
            withConfiguration(encoder.encode(alternative)),
          ),
        "configuration",
        "non_canonical",
      );
    }
  });

  it("rejects non-canonical and invalid trusted-image JSON independently", () => {
    const canonical = canonicalJson(fixtureTrustedImages());
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withTrustedImages(encoder.encode(`${canonical}\n`)),
        ),
      "trusted_images",
      "non_canonical",
    );
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes(
          withTrustedImages(encoder.encode("{}")),
        ),
      "trusted_images",
      "invalid_configuration",
    );
  });

  it("requires the exact 85-byte credential and redacts its value", () => {
    expect(encoder.encode(fixtureCredential)).toHaveLength(
      localRunnerCredentialBytes,
    );
    const malformed = `x${fixtureCredential.slice(1)}`;
    const error = expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes({
          ...validBytes(),
          credential: encoder.encode(malformed),
        }),
      "credential",
      "invalid_credential",
    );
    expect(JSON.stringify(error)).not.toContain(malformed);
    expect(error.message).not.toContain(malformed);
    expect(error.stack).not.toContain(malformed);

    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes({
          ...validBytes(),
          credential: encoder.encode(`${fixtureCredential}\n`),
        }),
      "credential",
      "invalid_size",
    );
    const invalidUtf8 = new Uint8Array(localRunnerCredentialBytes).fill(0x61);
    invalidUtf8[0] = 0xff;
    expectFailure(
      () =>
        parseLocalRunnerDeploymentBytes({
          ...validBytes(),
          credential: invalidUtf8,
        }),
      "credential",
      "invalid_utf8",
    );
  });

  it("rejects shared, resizable, detached, and proxied storage", () => {
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(
        new SharedArrayBuffer(validBytes().configuration.byteLength),
      );
      shared.set(validBytes().configuration);
      expectFailure(
        () => parseLocalRunnerDeploymentBytes(withConfiguration(shared)),
        "configuration",
        "invalid_storage",
      );
    }

    const ArrayBufferConstructor = ArrayBuffer as typeof ArrayBuffer & {
      new (length: number, options: { maxByteLength: number }): ArrayBuffer;
    };
    try {
      const resizableBuffer = new ArrayBufferConstructor(32, {
        maxByteLength: 64,
      });
      if (
        (resizableBuffer as ArrayBuffer & { readonly resizable?: boolean })
          .resizable === true
      ) {
        expectFailure(
          () =>
            parseLocalRunnerDeploymentBytes(
              withConfiguration(new Uint8Array(resizableBuffer)),
            ),
          "configuration",
          "invalid_storage",
        );
      }
    } catch {
      // The active runtime does not expose resizable ArrayBuffer construction.
    }

    const detachedBuffer = validBytes().configuration.buffer.slice(0);
    const detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(withConfiguration(detached)),
      "configuration",
      "invalid_storage",
    );

    const proxied = new Proxy(validBytes().configuration, {});
    expectFailure(
      () => parseLocalRunnerDeploymentBytes(withConfiguration(proxied)),
      "configuration",
      "invalid_storage",
    );
  });

  it("admits a canonical maximum-shape image catalog without narrowing its schema", () => {
    const maximumCommand = {
      executable: "/bin/x",
      arguments: [
        ...Array.from({ length: 15 }, () => "a".repeat(4_096)),
        "a".repeat(4_090),
      ],
    };
    const environment = Array.from({ length: 128 }, (_, index) => {
      const name = `VAR_${index.toString().padStart(3, "0")}=`;
      return `${name}${"x".repeat(2_048 - name.length)}`;
    });
    const digest = (value: number) =>
      `sha256:${value.toString(16).padStart(64, "0")}`;
    const catalog = {
      version: "1",
      images: Array.from({ length: 32 }, (_, index) => ({
        digest: digest(index + 1),
        manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
        configurationDigest: digest(100),
        architecture: index % 2 === 0 ? "amd64" : "arm64",
        runtimeBuildDigest: digest(101),
        runtimeBundleDigest: digest(102),
        runtime: maximumCommand,
        profileProbe: maximumCommand,
        environment,
      })),
    };
    const encoded = bytes(catalog);
    expect(encoded.byteLength).toBeLessThanOrEqual(
      maximumLocalRunnerTrustedImageBytes,
    );

    const parsed = parseLocalRunnerDeploymentBytes({
      ...validBytes(),
      trustedImages: encoded,
    });
    expect(parsed.trustedImages.images).toHaveLength(32);
    expect(parsed.trustedImages.images[31]?.environment).toHaveLength(128);
  });
});
