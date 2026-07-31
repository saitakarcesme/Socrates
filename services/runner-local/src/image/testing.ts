import { issueAdmittedSandboxImage } from "./capability";
import { sandboxProfileProbe } from "./profile-probe";

import type { AdmittedSandboxImage } from "./capability";

export function createAdmittedImageForTesting(
  reference: string,
  architecture: "amd64" | "arm64",
  configurationDigest?: string,
): AdmittedSandboxImage {
  const digest = reference.slice(reference.lastIndexOf("@") + 1);
  return issueAdmittedSandboxImage({
    reference: digest,
    localName: reference.slice(0, reference.lastIndexOf("@")) || reference,
    digest,
    configurationDigest: configurationDigest ?? digest,
    architecture,
    runtime: {
      executable: "/usr/local/bin/node",
      arguments: ["/opt/socrates/task-runtime.mjs"],
    },
    profileProbe: sandboxProfileProbe,
  });
}
