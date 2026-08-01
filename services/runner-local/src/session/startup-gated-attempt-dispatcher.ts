import type {
  RunnerStartupRecoveryBarrier,
  RunnerStartupRecoveryResult,
} from "../execution";
import { immutableEvidenceSnapshot } from "../work-journal/terminal-evidence-consistency";
import {
  admissionState,
  capturedComposition,
  freshSessionResultSnapshot,
  nonSessionAdmissionSnapshot,
  readyAdmissionSnapshot,
  recoveryAdmissionSnapshot,
  restartSessionResultSnapshot,
  type CapturedComposition,
  type StartupGatedAttemptComposition,
  type StartupGatedAttemptCompositionFactory,
  type StartupGatedAttemptDispatchResult,
} from "./startup-gated-attempt-contracts";

export {
  StartupGatedAttemptDispatcherError,
  type StartupGatedAttemptComposition,
  type StartupGatedAttemptCompositionFactory,
  type StartupGatedAttemptDispatchResult,
  type StartupGatedFreshSessionPort,
  type StartupGatedRestartSessionPort,
  type StartupGatedWorkAdmissionPort,
} from "./startup-gated-attempt-contracts";

export class StartupGatedAttemptDispatcher {
  readonly #recover: () => Promise<RunnerStartupRecoveryResult>;
  readonly #compose: (
    startup: RunnerStartupRecoveryResult,
  ) => Promise<StartupGatedAttemptComposition>;
  #compositionOperation: Promise<CapturedComposition> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #failed = false;
  #failure: unknown;

  constructor(options: {
    startup: RunnerStartupRecoveryBarrier;
    composition: StartupGatedAttemptCompositionFactory;
  }) {
    this.#recover = options.startup.recover.bind(options.startup);
    this.#compose = options.composition.compose.bind(options.composition);
  }

  dispatchNext(
    signal?: AbortSignal,
  ): Promise<StartupGatedAttemptDispatchResult> {
    const operation = this.#operationTail.then(() => this.#dispatch(signal));
    this.#operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #dispatch(
    signal?: AbortSignal,
  ): Promise<StartupGatedAttemptDispatchResult> {
    if (this.#failed) throw this.#failure;
    try {
      return await this.#perform(signal);
    } catch (cause) {
      if (!this.#failed) {
        this.#failed = true;
        this.#failure = cause;
      }
      throw this.#failure;
    }
  }

  async #perform(
    signal?: AbortSignal,
  ): Promise<StartupGatedAttemptDispatchResult> {
    const composition = await this.#ready();
    const admission = await composition.prepareNext(signal);
    const state = admissionState(admission);
    if (state === "ready") {
      const handoff = readyAdmissionSnapshot(admission);
      const session = composition.createFresh(handoff);
      const result = freshSessionResultSnapshot(
        await session.settle(),
        handoff.execution,
      );
      return immutableEvidenceSnapshot({
        state: "settled" as const,
        path: "fresh" as const,
        deliveryId: handoff.deliveryId,
        execution: handoff.execution,
        result,
      });
    }
    if (state === "recovery_pending") {
      const handoff = recoveryAdmissionSnapshot(admission);
      const session = composition.createRestartRecovery(handoff);
      const result = restartSessionResultSnapshot(
        await session.settle(),
        handoff.execution,
      );
      return immutableEvidenceSnapshot({
        state: "settled" as const,
        path: "restart_recovery" as const,
        deliveryId: handoff.deliveryId,
        execution: handoff.execution,
        result,
      });
    }
    return nonSessionAdmissionSnapshot(admission);
  }

  #ready(): Promise<CapturedComposition> {
    this.#compositionOperation ??= this.#composeAfterRecovery();
    return this.#compositionOperation;
  }

  async #composeAfterRecovery(): Promise<CapturedComposition> {
    const startup = await this.#recover();
    return capturedComposition(await this.#compose(startup));
  }
}
