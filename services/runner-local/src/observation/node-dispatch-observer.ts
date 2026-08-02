import type { StartupGatedAttemptDispatchResult } from "../session";
import {
  dispatchObservationFailure,
  NodeLocalRunnerDispatchObservationError,
} from "./dispatch-observation-contracts";
import { createDispatchObservationCore } from "./dispatch-observation-core";

type NodeByteWrite = (
  bytes: Uint8Array,
  callback: (error?: Error | null) => void,
) => boolean;

function nodeSink(write: NodeByteWrite) {
  return Object.freeze({
    write: (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        try {
          write(bytes, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (cause) {
          reject(cause);
        }
      }),
  });
}

export class NodeLocalRunnerDispatchObserver {
  readonly #observe: (
    result: StartupGatedAttemptDispatchResult,
  ) => Promise<void>;

  constructor() {
    let observe: (result: StartupGatedAttemptDispatchResult) => Promise<void>;
    try {
      const stderr = process.stderr;
      const candidate = stderr.write;
      if (typeof candidate !== "function") {
        dispatchObservationFailure("composition_failed");
      }
      const write = Reflect.apply(Function.prototype.bind, candidate, [
        stderr,
      ]) as NodeByteWrite;
      const core = createDispatchObservationCore(nodeSink(write));
      observe = core.observe;
    } catch {
      dispatchObservationFailure("composition_failed");
    }
    this.#observe = observe;
    Object.freeze(this);
  }

  observe(result: StartupGatedAttemptDispatchResult): Promise<void> {
    return this.#observe(result);
  }
}

export { NodeLocalRunnerDispatchObservationError };
export type { NodeLocalRunnerDispatchObservationErrorCode } from "./dispatch-observation-contracts";
