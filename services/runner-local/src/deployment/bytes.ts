import {
  runnerBearerTokenSchema,
  type RunnerBearerToken,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import {
  parseLocalRunnerConfiguration,
  type LocalRunnerConfigurationV1,
} from "../configuration";
import {
  parseLocalRunnerTrustedImageCatalogConfiguration,
  type LocalRunnerTrustedImageCatalogConfigurationV1,
} from "../image";

export const maximumLocalRunnerConfigurationBytes = 1_048_576;
export const maximumLocalRunnerTrustedImageBytes = 16_777_216;
export const localRunnerCredentialBytes = 85;

export type LocalRunnerDeploymentInputName =
  "configuration" | "trusted_images" | "credential";

export type LocalRunnerDeploymentBytesErrorCode =
  | "invalid_owner"
  | "invalid_storage"
  | "invalid_size"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_configuration"
  | "non_canonical"
  | "invalid_credential";

export class LocalRunnerDeploymentBytesError extends Error {
  constructor(
    readonly input: LocalRunnerDeploymentInputName,
    readonly code: LocalRunnerDeploymentBytesErrorCode,
  ) {
    super(`Local runner deployment ${input} failed ${code}.`);
    this.name = "LocalRunnerDeploymentBytesError";
    Object.freeze(this);
  }
}

export type LocalRunnerDeploymentBytes = Readonly<{
  configuration: Uint8Array;
  trustedImages: Uint8Array;
  credential: Uint8Array;
}>;

export type LocalRunnerDeploymentInputs = Readonly<{
  configuration: LocalRunnerConfigurationV1;
  trustedImages: LocalRunnerTrustedImageCatalogConfigurationV1;
  credential: RunnerBearerToken;
}>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const expectedOwnerKeys = new Set([
  "configuration",
  "trustedImages",
  "credential",
]);

function fail(
  input: LocalRunnerDeploymentInputName,
  code: LocalRunnerDeploymentBytesErrorCode,
): never {
  throw new LocalRunnerDeploymentBytesError(input, code);
}

function deploymentOwner(candidate: unknown): Record<string, unknown> {
  if (typeof candidate !== "object" || candidate === null) {
    return fail("configuration", "invalid_owner");
  }

  try {
    const prototype = Object.getPrototypeOf(candidate);
    const keys = Reflect.ownKeys(candidate);
    if (
      prototype !== Object.prototype ||
      keys.length !== expectedOwnerKeys.size ||
      keys.some((key) => typeof key !== "string" || !expectedOwnerKeys.has(key))
    ) {
      return fail("configuration", "invalid_owner");
    }
  } catch {
    return fail("configuration", "invalid_owner");
  }

  return candidate as Record<string, unknown>;
}

function isShared(buffer: ArrayBufferLike): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    buffer instanceof SharedArrayBuffer
  );
}

function isResizableOrDetached(buffer: ArrayBuffer): boolean {
  const inspected = buffer as ArrayBuffer & {
    readonly resizable?: boolean;
    readonly detached?: boolean;
  };
  return inspected.resizable === true || inspected.detached === true;
}

function snapshot(
  candidate: unknown,
  input: LocalRunnerDeploymentInputName,
  maximumBytes: number,
  exactBytes?: number,
): Uint8Array {
  let byteLength: number;
  let buffer: ArrayBufferLike;

  try {
    if (!(candidate instanceof Uint8Array)) {
      return fail(input, "invalid_owner");
    }
    byteLength = candidate.byteLength;
    buffer = candidate.buffer;
  } catch {
    return fail(input, "invalid_storage");
  }

  if (
    isShared(buffer) ||
    !(buffer instanceof ArrayBuffer) ||
    isResizableOrDetached(buffer)
  ) {
    return fail(input, "invalid_storage");
  }
  try {
    buffer.slice(0, 0);
  } catch {
    return fail(input, "invalid_storage");
  }
  if (
    (exactBytes === undefined &&
      (byteLength < 1 || byteLength > maximumBytes)) ||
    (exactBytes !== undefined && byteLength !== exactBytes)
  ) {
    return fail(input, "invalid_size");
  }

  try {
    return Uint8Array.from(candidate);
  } catch {
    return fail(input, "invalid_storage");
  }
}

function decode(bytes: Uint8Array, input: LocalRunnerDeploymentInputName) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return fail(input, "invalid_utf8");
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return fail(input, "invalid_utf8");
  }
  if (text.includes("\0")) return fail(input, "invalid_utf8");
  return text;
}

function parseJson(text: string, input: LocalRunnerDeploymentInputName) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(input, "invalid_json");
  }
}

function admitJson<T>(
  bytes: unknown,
  input: Exclude<LocalRunnerDeploymentInputName, "credential">,
  maximumBytes: number,
  admit: (candidate: unknown) => T,
): T {
  const copy = snapshot(bytes, input, maximumBytes);
  const text = decode(copy, input);
  const candidate = parseJson(text, input);
  let admitted: T;
  try {
    admitted = admit(candidate);
  } catch {
    return fail(input, "invalid_configuration");
  }
  if (canonicalJson(admitted) !== text) {
    return fail(input, "non_canonical");
  }
  return admitted;
}

function admitConfiguration(bytes: unknown): LocalRunnerConfigurationV1 {
  return admitJson(
    bytes,
    "configuration",
    maximumLocalRunnerConfigurationBytes,
    parseLocalRunnerConfiguration,
  );
}

function admitTrustedImages(
  bytes: unknown,
): LocalRunnerTrustedImageCatalogConfigurationV1 {
  return admitJson(
    bytes,
    "trusted_images",
    maximumLocalRunnerTrustedImageBytes,
    parseLocalRunnerTrustedImageCatalogConfiguration,
  );
}

function admitCredential(bytes: unknown): RunnerBearerToken {
  const copy = snapshot(
    bytes,
    "credential",
    localRunnerCredentialBytes,
    localRunnerCredentialBytes,
  );
  const credential = decode(copy, "credential");
  const admitted = runnerBearerTokenSchema.safeParse(credential);
  if (!admitted.success) return fail("credential", "invalid_credential");
  return admitted.data;
}

export function parseLocalRunnerDeploymentBytes(
  candidate: unknown,
): LocalRunnerDeploymentInputs {
  const owner = deploymentOwner(candidate);

  let configurationBytes: unknown;
  try {
    configurationBytes = owner.configuration;
  } catch {
    return fail("configuration", "invalid_owner");
  }
  const configuration = admitConfiguration(configurationBytes);

  let trustedImageBytes: unknown;
  try {
    trustedImageBytes = owner.trustedImages;
  } catch {
    return fail("trusted_images", "invalid_owner");
  }
  const trustedImages = admitTrustedImages(trustedImageBytes);

  let credentialBytes: unknown;
  try {
    credentialBytes = owner.credential;
  } catch {
    return fail("credential", "invalid_owner");
  }
  const credential = admitCredential(credentialBytes);

  return Object.freeze({ configuration, trustedImages, credential });
}
