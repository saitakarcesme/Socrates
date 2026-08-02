export type LocalRunnerDeploymentLoadErrorCode =
  "public_inputs_failed" | "credential_failed" | "composition_failed";

export class LocalRunnerDeploymentLoadError extends Error {
  constructor(readonly code: LocalRunnerDeploymentLoadErrorCode) {
    super(`Local runner deployment load failed ${code}.`);
    this.name = "LocalRunnerDeploymentLoadError";
    Object.freeze(this);
  }
}

export function deploymentLoadFailure(
  code: LocalRunnerDeploymentLoadErrorCode,
): never {
  throw new LocalRunnerDeploymentLoadError(code);
}
