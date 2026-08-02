import type { LocalRunnerDeploymentInputs } from "./bytes";
import { loadLocalRunnerDeploymentInputs } from "./deployment-loader-core";
import { NodeLocalRunnerPublicDeploymentLoader } from "./public-deployment-loader";
import { NodeLocalRunnerSystemdCredentialLoader } from "./systemd-credential-loader";

export class NodeLocalRunnerDeploymentLoader {
  constructor() {
    Object.freeze(this);
  }

  load(): Promise<LocalRunnerDeploymentInputs> {
    return loadLocalRunnerDeploymentInputs({
      loadPublicInputs: () =>
        new NodeLocalRunnerPublicDeploymentLoader().load(),
      loadCredential: () => new NodeLocalRunnerSystemdCredentialLoader().load(),
    });
  }
}
