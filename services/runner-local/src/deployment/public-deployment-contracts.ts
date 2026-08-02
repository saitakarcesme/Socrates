import type { LocalRunnerConfigurationV1 } from "../configuration";
import type { LocalRunnerTrustedImageCatalogConfigurationV1 } from "../image";

export type LocalRunnerPublicDeploymentLoadErrorCode =
  | "unsupported_host"
  | "invalid_host"
  | "open_failed"
  | "invalid_metadata"
  | "configuration_failed"
  | "trusted_images_failed"
  | "close_failed";

export class LocalRunnerPublicDeploymentLoadError extends Error {
  constructor(readonly code: LocalRunnerPublicDeploymentLoadErrorCode) {
    super(`Local runner public deployment load failed ${code}.`);
    this.name = "LocalRunnerPublicDeploymentLoadError";
    Object.freeze(this);
  }
}

export type LocalRunnerPublicDeploymentInputs = Readonly<{
  configuration: LocalRunnerConfigurationV1;
  trustedImages: LocalRunnerTrustedImageCatalogConfigurationV1;
}>;

export function publicDeploymentLoadFailure(
  code: LocalRunnerPublicDeploymentLoadErrorCode,
): never {
  throw new LocalRunnerPublicDeploymentLoadError(code);
}
