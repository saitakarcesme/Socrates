import type { SandboxCommand } from "../oci/profile";

export type AdmittedSandboxImage = Readonly<{
  reference: string;
  digest: string;
  architecture: "amd64" | "arm64";
  runtime: SandboxCommand;
  profileProbe: SandboxCommand;
}>;

const admittedImages = new WeakSet<object>();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const imageReferencePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u;
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
    !imageReferencePattern.test(image.reference) ||
    !image.reference.endsWith(`@${image.digest}`)
  ) {
    throw new TypeError("Image was not admitted by the trusted catalog.");
  }
  assertCommand(image.runtime);
  assertCommand(image.profileProbe);
}

export function issueAdmittedSandboxImage(input: {
  reference: string;
  digest: string;
  architecture: "amd64" | "arm64";
  runtime: SandboxCommand;
  profileProbe: SandboxCommand;
}): AdmittedSandboxImage {
  const image: AdmittedSandboxImage = Object.freeze({
    reference: input.reference,
    digest: input.digest,
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
