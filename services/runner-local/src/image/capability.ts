import type { SandboxCommand } from "../oci/profile";

export type AdmittedSandboxImage = Readonly<{
  reference: string;
  digest: string;
  configurationDigest: string;
  architecture: "amd64" | "arm64";
  runtime: SandboxCommand;
  profileProbe: SandboxCommand;
}>;

export type InspectedSandboxImage = Readonly<{
  reference: string;
  digest: string;
  configurationDigest: string;
  architecture: "amd64" | "arm64";
  profileProbe: SandboxCommand;
}>;

const admittedImages = new WeakSet<object>();
const inspectedImages = new WeakSet<object>();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const absoluteExecutablePattern =
  /^\/(?:[^/\0.][^/\0]*|\.(?!\.?\/)[^/\0]+)(?:\/[^/\0]+)*$/u;

function assertCommand(command: SandboxCommand): void {
  if (
    !absoluteExecutablePattern.test(command.executable) ||
    command.executable.includes("/../") ||
    command.executable.endsWith("/..") ||
    command.arguments.length > 128 ||
    command.arguments.some(
      (argument) => argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    throw new TypeError("Admitted image command is invalid.");
  }
}

export function assertAdmittedImage(
  image: AdmittedSandboxImage,
): asserts image is AdmittedSandboxImage {
  if (
    !admittedImages.has(image) ||
    !digestPattern.test(image.digest) ||
    !digestPattern.test(image.configurationDigest) ||
    image.reference !== image.digest
  ) {
    throw new TypeError("Image was not admitted by the trusted catalog.");
  }
  assertCommand(image.runtime);
  assertCommand(image.profileProbe);
}

export function issueAdmittedSandboxImage(input: {
  reference: string;
  digest: string;
  configurationDigest: string;
  architecture: "amd64" | "arm64";
  runtime: SandboxCommand;
  profileProbe: SandboxCommand;
}): AdmittedSandboxImage {
  const image: AdmittedSandboxImage = Object.freeze({
    reference: input.reference,
    digest: input.digest,
    configurationDigest: input.configurationDigest,
    architecture: input.architecture,
    runtime: Object.freeze({
      executable: input.runtime.executable,
      arguments: Object.freeze([...input.runtime.arguments]),
    }),
    profileProbe: Object.freeze({
      executable: input.profileProbe.executable,
      arguments: Object.freeze([...input.profileProbe.arguments]),
    }),
  });
  admittedImages.add(image);
  assertAdmittedImage(image);
  return image;
}

export function assertInspectedImage(
  image: InspectedSandboxImage,
): asserts image is InspectedSandboxImage {
  if (
    !inspectedImages.has(image) ||
    !digestPattern.test(image.digest) ||
    !digestPattern.test(image.configurationDigest) ||
    image.reference !== image.digest
  ) {
    throw new TypeError("Image was not issued from verified local inspection.");
  }
  assertCommand(image.profileProbe);
}

export function issueInspectedSandboxImage(input: {
  reference: string;
  digest: string;
  configurationDigest: string;
  architecture: "amd64" | "arm64";
  profileProbe: SandboxCommand;
}): InspectedSandboxImage {
  const image: InspectedSandboxImage = Object.freeze({
    reference: input.reference,
    digest: input.digest,
    configurationDigest: input.configurationDigest,
    architecture: input.architecture,
    profileProbe: Object.freeze({
      executable: input.profileProbe.executable,
      arguments: Object.freeze([...input.profileProbe.arguments]),
    }),
  });
  inspectedImages.add(image);
  assertInspectedImage(image);
  return image;
}

export type SandboxImageAuthority =
  AdmittedSandboxImage | InspectedSandboxImage;

export function assertSandboxImageAuthority(
  image: SandboxImageAuthority,
): asserts image is SandboxImageAuthority {
  if (admittedImages.has(image)) {
    assertAdmittedImage(image as AdmittedSandboxImage);
    return;
  }
  assertInspectedImage(image as InspectedSandboxImage);
}
