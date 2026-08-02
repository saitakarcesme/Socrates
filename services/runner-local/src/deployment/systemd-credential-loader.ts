import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";

import { admitLocalRunnerCredentialBytes } from "./bytes";
import { NodeBoundedRegularFileReader } from "./bounded-regular-file-reader";
import {
  systemdCredentialLoadFailure,
  type LocalRunnerSystemdCredential,
} from "./systemd-credential-contracts";
import {
  loadDescriptorAnchoredSystemdCredential,
  type SystemdCredentialDirectoryHandle,
} from "./systemd-credential-loader-core";

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
    return systemdCredentialLoadFailure("unsupported_host");
  }
  return (
    constants.O_RDONLY | directory | noFollow | nonBlock | noControllingTerminal
  );
}

export class NodeLocalRunnerSystemdCredentialLoader {
  constructor() {
    Object.freeze(this);
  }

  async load(): Promise<LocalRunnerSystemdCredential> {
    const flags = requiredDirectoryOpenFlags();
    const reader = new NodeBoundedRegularFileReader();
    return loadDescriptorAnchoredSystemdCredential({
      readCredentialsDirectory: () => process.env.CREDENTIALS_DIRECTORY,
      readEffectiveUid: () => process.geteuid?.(),
      inspectProcFilesystem: async () => {
        const metadata = await statfs("/proc/self/fd", { bigint: true });
        return metadata.type;
      },
      openDirectory: async (path) => {
        const handle = await open(path, flags);
        const retained: SystemdCredentialDirectoryHandle = {
          descriptor: handle.fd,
          stat: () => handle.stat({ bigint: true }),
          close: () => handle.close(),
        };
        return retained;
      },
      readFile: (request) => reader.read(request),
      admitCredential: admitLocalRunnerCredentialBytes,
    });
  }
}
