import type { SandboxOwnership } from "./identity";

export const sandboxAppArmorProfile = "socrates-sandbox";

export type SandboxResourceProfile = Readonly<{
  memoryBytes: number;
  cpuCount: number;
  maximumPids: number;
  workspaceBytes: number;
  temporaryBytes: number;
  sharedMemoryBytes: number;
}>;

export type SandboxCommand = Readonly<{
  executable: string;
  arguments: readonly string[];
}>;

const admittedSandboxImageBrand: unique symbol = Symbol(
  "socrates.admittedSandboxImage",
);

export type AdmittedSandboxImage = Readonly<{
  reference: string;
  digest: string;
  architecture: "amd64" | "arm64";
  profileProbe: SandboxCommand;
  [admittedSandboxImageBrand]: true;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageReferencePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const absoluteExecutablePattern =
  /^\/(?:[^/\0.][^/\0]*|\.(?!\.?\/)[^/\0]+)(?:\/[^/\0]+)*$/;

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

export function validateSandboxProfile(profile: SandboxResourceProfile): void {
  for (const [name, value] of [
    ["memoryBytes", profile.memoryBytes],
    ["maximumPids", profile.maximumPids],
    ["workspaceBytes", profile.workspaceBytes],
    ["temporaryBytes", profile.temporaryBytes],
    ["sharedMemoryBytes", profile.sharedMemoryBytes],
  ] as const) {
    positiveInteger(name, value);
  }
  if (!Number.isFinite(profile.cpuCount) || profile.cpuCount <= 0) {
    throw new RangeError("cpuCount must be a positive finite number.");
  }
}

export function assertAdmittedImage(
  image: AdmittedSandboxImage,
): asserts image is AdmittedSandboxImage {
  if (
    image[admittedSandboxImageBrand] !== true ||
    !digestPattern.test(image.digest) ||
    !imageReferencePattern.test(image.reference) ||
    !image.reference.endsWith(`@${image.digest}`)
  ) {
    throw new TypeError("Admitted image must be a digest-pinned reference.");
  }
  commandArguments(image.profileProbe);
}

export function unsafeCreateAdmittedImageForTesting(
  reference: string,
  architecture: "amd64" | "arm64",
): AdmittedSandboxImage {
  const digest = reference.slice(reference.lastIndexOf("@") + 1);
  const image: AdmittedSandboxImage = {
    reference,
    digest,
    architecture,
    profileProbe: Object.freeze({
      executable: "/usr/local/bin/node",
      arguments: Object.freeze([
        "-e",
        [
          "const fs=require('node:fs')",
          "const label=fs.readFileSync('/proc/self/attr/current','utf8').trim()",
          "const uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim()",
          "const status=fs.readFileSync('/proc/self/status','utf8')",
          "const capabilities=Object.fromEntries(status.split('\\n').filter(line=>/^Cap(?:Inh|Prm|Eff|Bnd|Amb):/.test(line)).map(line=>{const [name,value]=line.split(':');return [name,value.trim()]}))",
          "let denied=false",
          "try{fs.writeFileSync('/tmp/socrates-lsm-probe','probe')}catch(error){denied=error?.code==='EACCES'}",
          "process.stdout.write(JSON.stringify({label,denied,uidMap,capabilities}))",
        ].join(";"),
      ]),
    }),
    [admittedSandboxImageBrand]: true,
  };
  assertAdmittedImage(image);
  return Object.freeze(image);
}

function commandArguments(command: SandboxCommand): readonly string[] {
  if (
    !absoluteExecutablePattern.test(command.executable) ||
    command.executable.includes("/../") ||
    command.executable.endsWith("/..")
  ) {
    throw new TypeError(
      "Sandbox executable must be a normalized absolute path.",
    );
  }
  if (
    command.arguments.length > 128 ||
    command.arguments.some(
      (argument) => argument.length > 4_096 || argument.includes("\0"),
    )
  ) {
    throw new TypeError("Sandbox command arguments are invalid.");
  }
  return [command.executable, ...command.arguments];
}

export function buildCreateArguments(input: {
  ownership: SandboxOwnership;
  image: AdmittedSandboxImage;
  profile: SandboxResourceProfile;
  command: SandboxCommand;
}): readonly string[] {
  assertAdmittedImage(input.image);
  validateSandboxProfile(input.profile);
  const labels = Object.entries(input.ownership.labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--label", `${name}=${value}`]);

  return [
    "create",
    "--name",
    input.ownership.containerName,
    ...labels,
    "--network",
    "none",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--read-only",
    "--tmpfs",
    `/workspace:rw,noexec,nosuid,nodev,size=${input.profile.workspaceBytes}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${input.profile.temporaryBytes}`,
    "--tmpfs",
    `/dev/shm:rw,noexec,nosuid,nodev,size=${input.profile.sharedMemoryBytes}`,
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    `apparmor=${sandboxAppArmorProfile}`,
    "--memory",
    String(input.profile.memoryBytes),
    "--memory-swap",
    String(input.profile.memoryBytes),
    "--cpus",
    String(input.profile.cpuCount),
    "--pids-limit",
    String(input.profile.maximumPids),
    "--hostname",
    "socrates-sandbox",
    "--env",
    "SOCRATES_SANDBOX=1",
    input.image.reference,
    ...commandArguments(input.command),
  ];
}
