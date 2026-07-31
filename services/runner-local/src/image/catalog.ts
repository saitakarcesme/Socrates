import { runtimeAbi } from "@socrates/runtime-protocol";

import {
  issueAdmittedSandboxImage,
  issueInspectedSandboxImage,
} from "./capability";

import type { AdmittedSandboxImage } from "./capability";
import type { InspectedSandboxImage } from "./capability";
import type { SandboxImageInspection } from "./inspection";
import type { SandboxCommand } from "../oci/profile";

export type TrustedSandboxImage = Readonly<{
  reference: string;
  manifestDigest: string;
  manifestMediaType:
    | "application/vnd.docker.distribution.manifest.v2+json"
    | "application/vnd.oci.image.manifest.v1+json";
  configurationDigest: string;
  architecture: "amd64" | "arm64";
  runtimeBuildDigest: string;
  runtimeBundleDigest: string;
  runtime: SandboxCommand;
  profileProbe: SandboxCommand;
  environment: readonly string[];
}>;

export interface SandboxImageInspector {
  inspect(input: {
    reference: string;
    architecture: "amd64" | "arm64";
  }): Promise<SandboxImageInspection>;
}

export interface SandboxImageHandshakeVerifier {
  verify(input: {
    image: InspectedSandboxImage;
    runtime: SandboxCommand;
  }): Promise<Readonly<{ abi: string; buildDigest: string }>>;
}

export class SandboxImageCatalogError extends Error {
  constructor(
    readonly code:
      "configuration" | "handshake" | "inspection" | "not_configured",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxImageCatalogError";
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const executablePattern =
  /^\/(?:[^/\0.][^/\0]*|\.(?!\.?\/)[^/\0]+)(?:\/[^/\0]+)*$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/u;
const credentialNamePattern =
  /(?:AUTH|COOKIE|CREDENTIAL|KEY|PASS(?:WORD)?|SECRET|TOKEN)/u;
const manifestMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

function key(digest: string, architecture: "amd64" | "arm64"): string {
  return `${digest}/${architecture}`;
}

function assertCommand(command: SandboxCommand, field: string): void {
  if (
    !executablePattern.test(command.executable) ||
    command.arguments.length > 128 ||
    command.arguments.some(
      (argument) => argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    throw new SandboxImageCatalogError(
      "configuration",
      `Trusted image ${field} is invalid.`,
    );
  }
}

function expectedLabels(image: TrustedSandboxImage): Record<string, string> {
  return {
    "io.socrates.task-runtime.abi": runtimeAbi,
    "io.socrates.task-runtime.build-digest": image.runtimeBuildDigest,
    "io.socrates.task-runtime.bundle-digest": image.runtimeBundleDigest,
  };
}

function canonicalRecord(value: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function validateDeclaration(image: TrustedSandboxImage): void {
  if (
    !digestPattern.test(image.reference) ||
    !digestPattern.test(image.manifestDigest) ||
    image.reference !== image.manifestDigest ||
    !digestPattern.test(image.configurationDigest) ||
    !digestPattern.test(image.runtimeBuildDigest) ||
    !digestPattern.test(image.runtimeBundleDigest) ||
    !["amd64", "arm64"].includes(image.architecture) ||
    !manifestMediaTypes.has(image.manifestMediaType) ||
    !Array.isArray(image.environment) ||
    image.environment.some((entry) => typeof entry !== "string")
  ) {
    throw new SandboxImageCatalogError(
      "configuration",
      "Trusted image identity is invalid.",
    );
  }
  assertCommand(image.runtime, "runtime command");
  assertCommand(image.profileProbe, "profile probe");
  const names = new Set<string>();
  for (const entry of image.environment) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    if (
      separator < 1 ||
      !environmentNamePattern.test(name) ||
      credentialNamePattern.test(name) ||
      names.has(name) ||
      entry.includes("\0")
    ) {
      throw new SandboxImageCatalogError(
        "configuration",
        "Trusted image environment is invalid.",
      );
    }
    names.add(name);
  }
}

function assertInspection(
  expected: TrustedSandboxImage,
  observed: SandboxImageInspection,
): void {
  const expectedEntrypoint = [
    expected.runtime.executable,
    ...expected.runtime.arguments,
  ];
  if (
    observed.reference !== expected.reference ||
    observed.manifestDigest !== expected.manifestDigest ||
    observed.manifestMediaType !== expected.manifestMediaType ||
    observed.configurationDigest !== expected.configurationDigest ||
    observed.platform !== "linux" ||
    observed.architecture !== expected.architecture ||
    observed.user !== "65534:65534" ||
    !sameStrings(observed.environment, expected.environment) ||
    !sameStrings(observed.entrypoint, expectedEntrypoint) ||
    observed.command.length !== 0 ||
    canonicalRecord(observed.labels) !==
      canonicalRecord(expectedLabels(expected)) ||
    observed.workingDirectory !== "" ||
    observed.stopSignal !== ""
  ) {
    throw new SandboxImageCatalogError(
      "inspection",
      "Local image configuration does not match the trusted catalog.",
    );
  }
}

export class SandboxImageCatalog {
  readonly #images = new Map<string, TrustedSandboxImage>();
  readonly #admissions = new Map<string, Promise<AdmittedSandboxImage>>();

  constructor(
    images: readonly TrustedSandboxImage[],
    readonly inspector: SandboxImageInspector,
    readonly handshake: SandboxImageHandshakeVerifier,
  ) {
    if (images.length === 0) {
      throw new SandboxImageCatalogError(
        "configuration",
        "Trusted image catalog cannot be empty.",
      );
    }
    const references = new Set<string>();
    for (const image of images) {
      validateDeclaration(image);
      const imageKey = key(image.manifestDigest, image.architecture);
      if (this.#images.has(imageKey) || references.has(image.reference)) {
        throw new SandboxImageCatalogError(
          "configuration",
          "Trusted image catalog contains a duplicate identity.",
        );
      }
      const configured = Object.freeze({
        ...image,
        environment: Object.freeze([...image.environment]),
        runtime: Object.freeze({
          executable: image.runtime.executable,
          arguments: Object.freeze([...image.runtime.arguments]),
        }),
        profileProbe: Object.freeze({
          executable: image.profileProbe.executable,
          arguments: Object.freeze([...image.profileProbe.arguments]),
        }),
      });
      references.add(configured.reference);
      this.#images.set(imageKey, configured);
    }
  }

  admit(
    manifestDigest: string,
    architecture: "amd64" | "arm64",
  ): Promise<AdmittedSandboxImage> {
    const imageKey = key(manifestDigest, architecture);
    const configured = this.#images.get(imageKey);
    if (!configured) {
      return Promise.reject(
        new SandboxImageCatalogError(
          "not_configured",
          "Image digest and platform are not in the trusted catalog.",
        ),
      );
    }
    const existing = this.#admissions.get(imageKey);
    if (existing) return existing;
    const admission = this.#admit(configured).catch((error: unknown) => {
      this.#admissions.delete(imageKey);
      throw error;
    });
    this.#admissions.set(imageKey, admission);
    return admission;
  }

  async #admit(image: TrustedSandboxImage): Promise<AdmittedSandboxImage> {
    let inspection: SandboxImageInspection;
    try {
      inspection = await this.inspector.inspect({
        reference: image.reference,
        architecture: image.architecture,
      });
    } catch (cause) {
      if (cause instanceof SandboxImageCatalogError) throw cause;
      throw new SandboxImageCatalogError(
        "inspection",
        "Trusted local image inspection failed.",
        { cause },
      );
    }
    assertInspection(image, inspection);

    let handshake: Readonly<{ abi: string; buildDigest: string }>;
    try {
      handshake = await this.handshake.verify({
        image: issueInspectedSandboxImage({
          reference: image.reference,
          localName: inspection.localName,
          digest: image.manifestDigest,
          configurationDigest: image.configurationDigest,
          architecture: image.architecture,
          profileProbe: image.profileProbe,
        }),
        runtime: Object.freeze({
          executable: image.runtime.executable,
          arguments: Object.freeze([...image.runtime.arguments, "--handshake"]),
        }),
      });
    } catch (cause) {
      throw new SandboxImageCatalogError(
        "handshake",
        "Trusted image runtime handshake failed.",
        { cause },
      );
    }
    if (
      handshake.abi !== runtimeAbi ||
      handshake.buildDigest !== image.runtimeBuildDigest
    ) {
      throw new SandboxImageCatalogError(
        "handshake",
        "Runtime handshake does not match the trusted catalog.",
      );
    }
    return issueAdmittedSandboxImage({
      reference: image.reference,
      localName: inspection.localName,
      digest: image.manifestDigest,
      configurationDigest: image.configurationDigest,
      architecture: image.architecture,
      runtime: image.runtime,
      profileProbe: image.profileProbe,
    });
  }
}
