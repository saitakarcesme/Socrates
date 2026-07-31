import type { ProcessExecutor, ProcessResult } from "../oci/process";

type JsonObject = Record<string, unknown>;

export type SandboxImageInspection = Readonly<{
  reference: string;
  manifestDigest: string;
  manifestMediaType:
    | "application/vnd.docker.distribution.manifest.v2+json"
    | "application/vnd.oci.image.manifest.v1+json";
  configurationDigest: string;
  platform: "linux";
  architecture: "amd64" | "arm64";
  user: string;
  environment: readonly string[];
  entrypoint: readonly string[];
  command: readonly string[];
  labels: Readonly<Record<string, string>>;
  workingDirectory: string;
  stopSignal: string;
}>;

export class SandboxImageInspectionError extends Error {
  constructor(
    readonly code: "engine" | "invalid_output" | "mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxImageInspectionError";
  }
}

export type NerdctlImageInspectorOptions = Readonly<{
  executable?: string;
  timeoutMs?: number;
  maximumOutputBytes?: number;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const acceptedManifestMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Image inspection field ${field} must be an object.`,
    );
  }
  return value as JsonObject;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Image inspection field ${field} must be a string.`,
    );
  }
  return value;
}

function digest(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!digestPattern.test(parsed)) {
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Image inspection field ${field} must be a digest.`,
    );
  }
  return parsed;
}

function strings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Image inspection field ${field} must be a string array.`,
    );
  }
  return Object.freeze([...value]) as readonly string[];
}

function optionalStrings(value: unknown, field: string): readonly string[] {
  return value === null || value === undefined
    ? Object.freeze([])
    : strings(value, field);
}

function stringRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return Object.freeze({});
  const parsed = object(value, field);
  if (Object.values(parsed).some((entry) => typeof entry !== "string")) {
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Image inspection field ${field} must contain only strings.`,
    );
  }
  return Object.freeze({ ...parsed }) as Readonly<Record<string, string>>;
}

function requireAbsentObject(value: unknown, field: string): void {
  if (value === null || value === undefined) return;
  if (Object.keys(object(value, field)).length === 0) return;
  throw new SandboxImageInspectionError(
    "mismatch",
    `Image inspection field ${field} must be absent.`,
  );
}

function parseJson(result: ProcessResult, mode: string): JsonObject {
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== "") {
    throw new SandboxImageInspectionError(
      "engine",
      `Local ${mode} image inspection failed.`,
    );
  }
  try {
    return object(JSON.parse(result.stdout) as unknown, mode);
  } catch (cause) {
    if (cause instanceof SandboxImageInspectionError) throw cause;
    throw new SandboxImageInspectionError(
      "invalid_output",
      `Local ${mode} image inspection returned invalid JSON.`,
      { cause },
    );
  }
}

export function parseSandboxImageInspection(input: {
  reference: string;
  architecture: "amd64" | "arm64";
  dockerCompatible: ProcessResult;
  native: ProcessResult;
}): SandboxImageInspection {
  const compatible = parseJson(input.dockerCompatible, "docker-compatible");
  const native = parseJson(input.native, "native");
  const configuration = object(compatible["Config"], "Config");
  const image = object(native["Image"], "Image");
  const target = object(image["Target"], "Image.Target");
  string(image["Name"], "Image.Name");
  const manifestDigest = digest(target["digest"], "Image.Target.digest");
  const mediaType = string(target["mediaType"], "Image.Target.mediaType");
  if (!acceptedManifestMediaTypes.has(mediaType)) {
    throw new SandboxImageInspectionError(
      "invalid_output",
      "Native image inspection has an unsupported manifest media type.",
    );
  }
  if (manifestDigest !== input.reference) {
    throw new SandboxImageInspectionError(
      "mismatch",
      "Local image target does not match its digest-pinned reference.",
    );
  }
  strings(compatible["RepoDigests"], "RepoDigests");
  if (
    compatible["Os"] !== "linux" ||
    compatible["Architecture"] !== input.architecture
  ) {
    throw new SandboxImageInspectionError(
      "mismatch",
      "Local image platform does not match the requested platform.",
    );
  }
  requireAbsentObject(configuration["Volumes"], "Config.Volumes");
  requireAbsentObject(configuration["Healthcheck"], "Config.Healthcheck");

  return Object.freeze({
    reference: input.reference,
    manifestDigest,
    manifestMediaType: mediaType as SandboxImageInspection["manifestMediaType"],
    configurationDigest: digest(compatible["Id"], "Id"),
    platform: "linux",
    architecture: input.architecture,
    user: string(configuration["User"], "Config.User"),
    environment: strings(configuration["Env"], "Config.Env"),
    entrypoint: strings(configuration["Entrypoint"], "Config.Entrypoint"),
    command: optionalStrings(configuration["Cmd"], "Config.Cmd"),
    labels: stringRecord(configuration["Labels"], "Config.Labels"),
    workingDirectory:
      configuration["WorkingDir"] === undefined
        ? ""
        : string(configuration["WorkingDir"], "Config.WorkingDir"),
    stopSignal:
      configuration["StopSignal"] === undefined
        ? ""
        : string(configuration["StopSignal"], "Config.StopSignal"),
  });
}

export class NerdctlImageInspector {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maximumOutputBytes: number;

  constructor(
    readonly processes: ProcessExecutor,
    options: NerdctlImageInspectorOptions = {},
  ) {
    this.#executable = options.executable ?? "nerdctl";
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maximumOutputBytes = options.maximumOutputBytes ?? 1 * 1_024 * 1_024;
  }

  async inspect(input: {
    reference: string;
    architecture: "amd64" | "arm64";
  }): Promise<SandboxImageInspection> {
    const baseArguments = [
      "image",
      "inspect",
      "--platform",
      `linux/${input.architecture}`,
      "--format",
      "{{json .}}",
    ];
    const run = (mode: "dockercompat" | "native") =>
      this.processes.run({
        executable: this.#executable,
        arguments: [...baseArguments, "--mode", mode, input.reference],
        timeoutMs: this.#timeoutMs,
        maximumOutputBytes: this.#maximumOutputBytes,
      });
    const [dockerCompatible, native] = await Promise.all([
      run("dockercompat"),
      run("native"),
    ]);
    return parseSandboxImageInspection({
      ...input,
      dockerCompatible,
      native,
    });
  }
}
