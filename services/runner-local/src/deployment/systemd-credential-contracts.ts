import type { RunnerBearerToken } from "@socrates/contracts";

export type LocalRunnerSystemdCredentialLoadErrorCode =
  | "unsupported_host"
  | "invalid_environment"
  | "invalid_identity"
  | "invalid_host"
  | "open_failed"
  | "invalid_metadata"
  | "credential_failed"
  | "close_failed";

export class LocalRunnerSystemdCredentialLoadError extends Error {
  constructor(readonly code: LocalRunnerSystemdCredentialLoadErrorCode) {
    super(`Systemd runner credential load failed ${code}.`);
    this.name = "LocalRunnerSystemdCredentialLoadError";
    Object.freeze(this);
  }
}

export type LocalRunnerSystemdCredential = RunnerBearerToken;

export function systemdCredentialLoadFailure(
  code: LocalRunnerSystemdCredentialLoadErrorCode,
): never {
  throw new LocalRunnerSystemdCredentialLoadError(code);
}
