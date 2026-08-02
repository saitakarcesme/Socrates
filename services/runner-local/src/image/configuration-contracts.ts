import { z } from "zod";

import type { SandboxCommand } from "../oci/profile";

export const maximumTrustedImageCatalogImages = 32;
export const maximumTrustedImageConfigurationDepth = 32;
export const maximumTrustedImageConfigurationNodes = 10_000;
export const maximumTrustedImageCommandArguments = 128;
export const maximumTrustedImageCommandValueBytes = 4_096;
export const maximumTrustedImageCommandBytes = 65_536;
export const maximumTrustedImageEnvironmentEntries = 128;
export const maximumTrustedImageEnvironmentEntryBytes = 8_192;
export const maximumTrustedImageEnvironmentBytes = 262_144;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absoluteExecutablePattern = /^\/[^/\0]+(?:\/[^/\0]+)*$/u;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/u;
const credentialNamePattern =
  /(?:AUTH|COOKIE|CREDENTIAL|KEY|PASS(?:WORD)?|SECRET|TOKEN)/u;
const encoder = new TextEncoder();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

const commandValueSchema = z
  .string()
  .max(maximumTrustedImageCommandValueBytes)
  .refine(
    (value) =>
      !value.includes("\0") &&
      bytes(value) <= maximumTrustedImageCommandValueBytes,
  );

const executableSchema = commandValueSchema.refine(
  (value) =>
    absoluteExecutablePattern.test(value) &&
    value
      .split("/")
      .slice(1)
      .every((segment) => segment !== "." && segment !== ".."),
);

const commandSchema = z
  .object({
    executable: executableSchema,
    arguments: z
      .array(commandValueSchema)
      .max(maximumTrustedImageCommandArguments),
  })
  .strict()
  .superRefine((command, context) => {
    const aggregate = [command.executable, ...command.arguments].reduce(
      (total, value) => total + bytes(value),
      0,
    );
    if (aggregate > maximumTrustedImageCommandBytes) {
      context.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "Trusted image command exceeds its aggregate byte limit.",
      });
    }
  });

const environmentEntrySchema = z
  .string()
  .max(maximumTrustedImageEnvironmentEntryBytes)
  .refine(
    (value) =>
      !value.includes("\0") &&
      bytes(value) <= maximumTrustedImageEnvironmentEntryBytes,
  );

const environmentSchema = z
  .array(environmentEntrySchema)
  .max(maximumTrustedImageEnvironmentEntries)
  .superRefine((environment, context) => {
    const names = new Set<string>();
    let aggregate = 0;
    for (const [index, entry] of environment.entries()) {
      aggregate += bytes(entry);
      const separator = entry.indexOf("=");
      const name = separator < 0 ? entry : entry.slice(0, separator);
      if (
        separator < 1 ||
        !environmentNamePattern.test(name) ||
        credentialNamePattern.test(name) ||
        names.has(name)
      ) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Trusted image environment entry is invalid.",
        });
      }
      names.add(name);
    }
    if (aggregate > maximumTrustedImageEnvironmentBytes) {
      context.addIssue({
        code: "custom",
        message: "Trusted image environment exceeds its aggregate byte limit.",
      });
    }
  });

export const trustedSandboxImageSchema = z
  .object({
    digest: digestSchema,
    manifestMediaType: z.enum([
      "application/vnd.docker.distribution.manifest.v2+json",
      "application/vnd.oci.image.manifest.v1+json",
    ]),
    configurationDigest: digestSchema,
    architecture: z.enum(["amd64", "arm64"]),
    runtimeBuildDigest: digestSchema,
    runtimeBundleDigest: digestSchema,
    runtime: commandSchema,
    profileProbe: commandSchema,
    environment: environmentSchema,
  })
  .strict();

export const localRunnerTrustedImageCatalogConfigurationV1Schema = z
  .object({
    version: z.literal("1"),
    images: z
      .array(trustedSandboxImageSchema)
      .min(1)
      .max(maximumTrustedImageCatalogImages),
  })
  .strict()
  .superRefine((configuration, context) => {
    const digests = new Set<string>();
    for (const [index, image] of configuration.images.entries()) {
      if (digests.has(image.digest)) {
        context.addIssue({
          code: "custom",
          path: ["images", index, "digest"],
          message: "Trusted image digest is duplicated.",
        });
      }
      digests.add(image.digest);
    }
  });

export type TrustedSandboxImage = Readonly<{
  digest: string;
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

export type LocalRunnerTrustedImageCatalogConfigurationV1 = Readonly<{
  version: "1";
  images: readonly TrustedSandboxImage[];
}>;
