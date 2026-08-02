import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";

import {
  admitLocalRunnerConfigurationBytes,
  admitLocalRunnerTrustedImageBytes,
} from "./bytes";
import { NodeBoundedRegularFileReader } from "./bounded-regular-file-reader";
import {
  type LocalRunnerPublicDeploymentInputs,
  publicDeploymentLoadFailure,
} from "./public-deployment-contracts";
import {
  loadDescriptorAnchoredPublicDeployment,
  type PublicDeploymentDirectoryHandle,
} from "./public-deployment-loader-core";

function requiredDirectoryOpenFlags(): number {
  const directory = constants.O_DIRECTORY as number | undefined;
  const noFollow = constants.O_NOFOLLOW as number | undefined;
  const nonBlock = constants.O_NONBLOCK as number | undefined;
  const noControllingTerminal = constants.O_NOCTTY as number | undefined;
  if (
    process.platform !== "linux" ||
    typeof directory !== "number" ||
    typeof noFollow !== "number" ||
    typeof nonBlock !== "number" ||
    typeof noControllingTerminal !== "number"
  ) {
    return publicDeploymentLoadFailure("unsupported_host");
  }
  return (
    constants.O_RDONLY | directory | noFollow | nonBlock | noControllingTerminal
  );
}

export class NodeLocalRunnerPublicDeploymentLoader {
  constructor() {
    Object.freeze(this);
  }

  async load(): Promise<LocalRunnerPublicDeploymentInputs> {
    const flags = requiredDirectoryOpenFlags();
    const reader = new NodeBoundedRegularFileReader();
    return loadDescriptorAnchoredPublicDeployment({
      inspectProcFilesystem: async () => {
        const metadata = await statfs("/proc/self/fd", { bigint: true });
        return metadata.type;
      },
      openDirectory: async (path) => {
        const handle = await open(path, flags);
        const retained: PublicDeploymentDirectoryHandle = {
          descriptor: handle.fd,
          stat: () => handle.stat({ bigint: true }),
          close: () => handle.close(),
        };
        return retained;
      },
      readFile: (request) => reader.read(request),
      admitConfiguration: admitLocalRunnerConfigurationBytes,
      admitTrustedImages: admitLocalRunnerTrustedImageBytes,
    });
  }
}
