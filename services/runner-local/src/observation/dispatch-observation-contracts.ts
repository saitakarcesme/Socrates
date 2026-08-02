export const localRunnerDispatchObservationSchema =
  "socrates.local-runner.dispatch-observation.v1";
export const maximumLocalRunnerDispatchObservationBytes = 2_048;

export type NodeLocalRunnerDispatchObservationErrorCode =
  "composition_failed" | "projection_failed" | "write_failed";

export class NodeLocalRunnerDispatchObservationError extends Error {
  constructor(readonly code: NodeLocalRunnerDispatchObservationErrorCode) {
    super("Local runner dispatch observation failed.");
    this.name = "NodeLocalRunnerDispatchObservationError";
    Object.freeze(this);
  }
}

export function dispatchObservationFailure(
  code: NodeLocalRunnerDispatchObservationErrorCode,
): never {
  throw new NodeLocalRunnerDispatchObservationError(code);
}
