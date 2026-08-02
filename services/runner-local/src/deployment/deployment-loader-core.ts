import type { RunnerBearerToken } from "@socrates/contracts";

import type { LocalRunnerDeploymentInputs } from "./bytes";
import {
  deploymentLoadFailure,
  type LocalRunnerDeploymentLoadErrorCode,
} from "./deployment-loader-contracts";
import type { LocalRunnerPublicDeploymentInputs } from "./public-deployment-contracts";

export interface LocalRunnerDeploymentLoaderOperations {
  loadPublicInputs(): Promise<LocalRunnerPublicDeploymentInputs>;
  loadCredential(): Promise<RunnerBearerToken>;
}

async function loadStage<T>(
  operation: () => Promise<T>,
  failure: LocalRunnerDeploymentLoadErrorCode,
): Promise<T> {
  try {
    return await operation();
  } catch {
    return deploymentLoadFailure(failure);
  }
}

export async function loadLocalRunnerDeploymentInputs(
  operations: LocalRunnerDeploymentLoaderOperations,
): Promise<LocalRunnerDeploymentInputs> {
  const publicInputs = await loadStage(
    () => operations.loadPublicInputs(),
    "public_inputs_failed",
  );
  const credential = await loadStage(
    () => operations.loadCredential(),
    "credential_failed",
  );

  try {
    return Object.freeze({
      configuration: publicInputs.configuration,
      trustedImages: publicInputs.trustedImages,
      credential,
    });
  } catch {
    return deploymentLoadFailure("composition_failed");
  }
}
