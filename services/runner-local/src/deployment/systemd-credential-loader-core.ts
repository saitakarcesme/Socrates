import type { BigIntStats } from "node:fs";

import type { RunnerBearerToken } from "@socrates/contracts";

import { localRunnerCredentialBytes } from "./bytes";
import type { NodeBoundedRegularFileReadRequest } from "./bounded-regular-file-contracts";
import {
  LocalRunnerSystemdCredentialLoadError,
  systemdCredentialLoadFailure,
} from "./systemd-credential-contracts";

const expectedCredentialsDirectory =
  "/run/credentials/socrates-runner-local.service";
const procDescriptorRoot = "/proc/self/fd";
const procSuperMagic = 0x9fa0n;
const directoryPermissionMask = 0o777n;
const publicDirectoryMode = 0o755n;
const unitDirectoryMode = 0o500n;
const credentialName = "runner-bearer-token";
const maximumLinuxUid = 4_294_967_294;
const directoryComponents = [
  "run",
  "credentials",
  "socrates-runner-local.service",
] as const;

export interface SystemdCredentialDirectoryHandle {
  readonly descriptor: number;
  stat(): Promise<BigIntStats>;
  close(): Promise<void>;
}

export interface SystemdCredentialLoaderOperations {
  readCredentialsDirectory(): unknown;
  readEffectiveUid(): unknown;
  inspectProcFilesystem(): Promise<bigint>;
  openDirectory(path: string): Promise<SystemdCredentialDirectoryHandle>;
  readFile(request: NodeBoundedRegularFileReadRequest): Promise<Uint8Array>;
  admitCredential(bytes: Uint8Array): RunnerBearerToken;
}

function descriptorPath(descriptor: number, component: string): string {
  return `${procDescriptorRoot}/${descriptor}/${component}`;
}

function requireEnvironment(
  operations: SystemdCredentialLoaderOperations,
): void {
  let value: unknown;
  try {
    value = operations.readCredentialsDirectory();
  } catch {
    return systemdCredentialLoadFailure("invalid_environment");
  }
  if (value !== expectedCredentialsDirectory) {
    return systemdCredentialLoadFailure("invalid_environment");
  }
}

function requireEffectiveUid(
  operations: SystemdCredentialLoaderOperations,
): number {
  let value: unknown;
  try {
    value = operations.readEffectiveUid();
  } catch {
    return systemdCredentialLoadFailure("invalid_identity");
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximumLinuxUid
  ) {
    return systemdCredentialLoadFailure("invalid_identity");
  }
  return value as number;
}

async function requireDirectoryMetadata(
  handle: SystemdCredentialDirectoryHandle,
  effectiveUid: number,
  unitDirectory: boolean,
): Promise<Readonly<{ descriptor: number; owner: number }>> {
  let descriptor: unknown;
  let metadata: BigIntStats;
  try {
    descriptor = handle.descriptor;
    metadata = await handle.stat();
  } catch {
    return systemdCredentialLoadFailure("invalid_metadata");
  }
  let owner: bigint;
  try {
    owner = metadata.uid;
    const mode = metadata.mode & directoryPermissionMask;
    if (
      !Number.isSafeInteger(descriptor) ||
      (descriptor as number) < 0 ||
      (descriptor as number) > 2_147_483_647 ||
      !metadata.isDirectory() ||
      (!unitDirectory && (owner !== 0n || mode !== publicDirectoryMode)) ||
      (unitDirectory &&
        (mode !== unitDirectoryMode ||
          (owner !== 0n && owner !== BigInt(effectiveUid))))
    ) {
      return systemdCredentialLoadFailure("invalid_metadata");
    }
  } catch (error) {
    if (error instanceof LocalRunnerSystemdCredentialLoadError) throw error;
    return systemdCredentialLoadFailure("invalid_metadata");
  }
  return Object.freeze({
    descriptor: descriptor as number,
    owner: Number(owner),
  });
}

async function openDirectory(
  operations: SystemdCredentialLoaderOperations,
  handles: SystemdCredentialDirectoryHandle[],
  path: string,
  effectiveUid: number,
  unitDirectory: boolean,
): Promise<
  Readonly<{
    handle: SystemdCredentialDirectoryHandle;
    descriptor: number;
    owner: number;
  }>
> {
  let handle: SystemdCredentialDirectoryHandle;
  try {
    handle = await operations.openDirectory(path);
  } catch {
    return systemdCredentialLoadFailure("open_failed");
  }
  handles.push(handle);
  const authority = await requireDirectoryMetadata(
    handle,
    effectiveUid,
    unitDirectory,
  );
  return Object.freeze({ handle, ...authority });
}

async function loadWithOpenHandles(
  operations: SystemdCredentialLoaderOperations,
  handles: SystemdCredentialDirectoryHandle[],
): Promise<RunnerBearerToken> {
  requireEnvironment(operations);
  const effectiveUid = requireEffectiveUid(operations);

  let filesystemType: bigint;
  try {
    filesystemType = await operations.inspectProcFilesystem();
  } catch {
    return systemdCredentialLoadFailure("invalid_host");
  }
  if (filesystemType !== procSuperMagic) {
    return systemdCredentialLoadFailure("invalid_host");
  }

  let current = await openDirectory(
    operations,
    handles,
    "/",
    effectiveUid,
    false,
  );
  for (const [index, component] of directoryComponents.entries()) {
    current = await openDirectory(
      operations,
      handles,
      descriptorPath(current.descriptor, component),
      effectiveUid,
      index === directoryComponents.length - 1,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await operations.readFile({
      path: descriptorPath(current.descriptor, credentialName),
      maximumBytes: localRunnerCredentialBytes,
      expectedOwnerUid: current.owner,
      mode: 0o400,
    });
  } catch {
    return systemdCredentialLoadFailure("credential_failed");
  }
  try {
    return operations.admitCredential(bytes);
  } catch {
    return systemdCredentialLoadFailure("credential_failed");
  }
}

function normalizeFailure(
  error: unknown,
): LocalRunnerSystemdCredentialLoadError {
  return error instanceof LocalRunnerSystemdCredentialLoadError
    ? error
    : new LocalRunnerSystemdCredentialLoadError("invalid_host");
}

export async function loadDescriptorAnchoredSystemdCredential(
  operations: SystemdCredentialLoaderOperations,
): Promise<RunnerBearerToken> {
  const handles: SystemdCredentialDirectoryHandle[] = [];
  let credential: RunnerBearerToken | undefined;
  let failure: LocalRunnerSystemdCredentialLoadError | undefined;
  try {
    credential = await loadWithOpenHandles(operations, handles);
  } catch (error) {
    failure = normalizeFailure(error);
  }

  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      await handles[index]!.close();
    } catch {
      failure ??= new LocalRunnerSystemdCredentialLoadError("close_failed");
    }
  }

  if (failure) throw failure;
  if (!credential) return systemdCredentialLoadFailure("credential_failed");
  return credential;
}
