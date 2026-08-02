import type { BigIntStats } from "node:fs";

import type { LocalRunnerConfigurationV1 } from "../configuration";
import type { LocalRunnerTrustedImageCatalogConfigurationV1 } from "../image";
import {
  maximumLocalRunnerConfigurationBytes,
  maximumLocalRunnerTrustedImageBytes,
} from "./bytes";
import type { NodeBoundedRegularFileReadRequest } from "./bounded-regular-file-contracts";
import {
  LocalRunnerPublicDeploymentLoadError,
  type LocalRunnerPublicDeploymentInputs,
  publicDeploymentLoadFailure,
} from "./public-deployment-contracts";

const directoryPermissionMask = 0o777n;
const expectedDirectoryMode = 0o755n;
const procDescriptorRoot = "/proc/self/fd";
const procSuperMagic = 0x9fa0n;
const publicDirectoryComponents = ["etc", "socrates", "runner-local"] as const;
const configurationName = "configuration.v1.json";
const trustedImagesName = "trusted-images.v1.json";

export interface PublicDeploymentDirectoryHandle {
  readonly descriptor: number;
  stat(): Promise<BigIntStats>;
  close(): Promise<void>;
}

export interface PublicDeploymentLoaderOperations {
  inspectProcFilesystem(): Promise<bigint>;
  openDirectory(path: string): Promise<PublicDeploymentDirectoryHandle>;
  readFile(request: NodeBoundedRegularFileReadRequest): Promise<Uint8Array>;
  admitConfiguration(bytes: Uint8Array): LocalRunnerConfigurationV1;
  admitTrustedImages(
    bytes: Uint8Array,
  ): LocalRunnerTrustedImageCatalogConfigurationV1;
}

function descriptorPath(descriptor: number, component: string): string {
  return `${procDescriptorRoot}/${descriptor}/${component}`;
}

async function requireDirectoryMetadata(
  handle: PublicDeploymentDirectoryHandle,
): Promise<void> {
  if (
    !Number.isSafeInteger(handle.descriptor) ||
    handle.descriptor < 0 ||
    handle.descriptor > 2_147_483_647
  ) {
    return publicDeploymentLoadFailure("invalid_metadata");
  }

  let metadata: BigIntStats;
  try {
    metadata = await handle.stat();
  } catch {
    return publicDeploymentLoadFailure("invalid_metadata");
  }
  if (
    !metadata.isDirectory() ||
    metadata.uid !== 0n ||
    (metadata.mode & directoryPermissionMask) !== expectedDirectoryMode
  ) {
    return publicDeploymentLoadFailure("invalid_metadata");
  }
}

async function openDirectory(
  operations: PublicDeploymentLoaderOperations,
  handles: PublicDeploymentDirectoryHandle[],
  path: string,
): Promise<PublicDeploymentDirectoryHandle> {
  let handle: PublicDeploymentDirectoryHandle;
  try {
    handle = await operations.openDirectory(path);
  } catch {
    return publicDeploymentLoadFailure("open_failed");
  }
  handles.push(handle);
  await requireDirectoryMetadata(handle);
  return handle;
}

async function readConfiguration(
  operations: PublicDeploymentLoaderOperations,
  directoryDescriptor: number,
): Promise<LocalRunnerConfigurationV1> {
  let bytes: Uint8Array;
  try {
    bytes = await operations.readFile({
      path: descriptorPath(directoryDescriptor, configurationName),
      maximumBytes: maximumLocalRunnerConfigurationBytes,
      expectedOwnerUid: 0,
      mode: 0o444,
    });
  } catch {
    return publicDeploymentLoadFailure("configuration_failed");
  }
  try {
    return operations.admitConfiguration(bytes);
  } catch {
    return publicDeploymentLoadFailure("configuration_failed");
  }
}

async function readTrustedImages(
  operations: PublicDeploymentLoaderOperations,
  directoryDescriptor: number,
): Promise<LocalRunnerTrustedImageCatalogConfigurationV1> {
  let bytes: Uint8Array;
  try {
    bytes = await operations.readFile({
      path: descriptorPath(directoryDescriptor, trustedImagesName),
      maximumBytes: maximumLocalRunnerTrustedImageBytes,
      expectedOwnerUid: 0,
      mode: 0o444,
    });
  } catch {
    return publicDeploymentLoadFailure("trusted_images_failed");
  }
  try {
    return operations.admitTrustedImages(bytes);
  } catch {
    return publicDeploymentLoadFailure("trusted_images_failed");
  }
}

async function loadWithOpenHandles(
  operations: PublicDeploymentLoaderOperations,
  handles: PublicDeploymentDirectoryHandle[],
): Promise<LocalRunnerPublicDeploymentInputs> {
  let filesystemType: bigint;
  try {
    filesystemType = await operations.inspectProcFilesystem();
  } catch {
    return publicDeploymentLoadFailure("invalid_host");
  }
  if (filesystemType !== procSuperMagic) {
    return publicDeploymentLoadFailure("invalid_host");
  }

  let parent = await openDirectory(operations, handles, "/");
  for (const component of publicDirectoryComponents) {
    parent = await openDirectory(
      operations,
      handles,
      descriptorPath(parent.descriptor, component),
    );
  }

  const configuration = await readConfiguration(operations, parent.descriptor);
  const trustedImages = await readTrustedImages(operations, parent.descriptor);
  return Object.freeze({ configuration, trustedImages });
}

function normalizeFailure(
  error: unknown,
): LocalRunnerPublicDeploymentLoadError {
  return error instanceof LocalRunnerPublicDeploymentLoadError
    ? error
    : new LocalRunnerPublicDeploymentLoadError("invalid_host");
}

export async function loadDescriptorAnchoredPublicDeployment(
  operations: PublicDeploymentLoaderOperations,
): Promise<LocalRunnerPublicDeploymentInputs> {
  const handles: PublicDeploymentDirectoryHandle[] = [];
  let inputs: LocalRunnerPublicDeploymentInputs | undefined;
  let failure: LocalRunnerPublicDeploymentLoadError | undefined;
  try {
    inputs = await loadWithOpenHandles(operations, handles);
  } catch (error) {
    failure = normalizeFailure(error);
  }

  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      await handles[index]!.close();
    } catch {
      failure ??= new LocalRunnerPublicDeploymentLoadError("close_failed");
    }
  }

  if (failure) throw failure;
  if (!inputs) return publicDeploymentLoadFailure("invalid_host");
  return inputs;
}
