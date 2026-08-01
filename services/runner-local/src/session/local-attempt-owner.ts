import { RunnerStartupRecoveryBarrier } from "../execution";
import { LocalEventSpool } from "../spool/store";
import { SequentialSpoolSender } from "../transport/sender";
import { WorkCompletionCoordinator } from "../work-journal/completion-coordinator";
import { WorkAdmissionCoordinator } from "../work-journal/coordinator";
import { TerminalEvidenceRecoveryCoordinator } from "../work-journal/terminal-evidence-recovery";
import { TerminalPublicationDispositionAuditor } from "../work-journal/terminal-publication-disposition";
import { LocalWorkJournal } from "../work-journal/store";
import { FreshAttemptSession } from "./fresh-attempt-session";
import {
  captureLocalAttemptOwnerOptions,
  type CapturedOptions,
  type LocalAttemptOwnerOptions,
} from "./local-attempt-owner-config";
import { RestartTerminalRecoverySession } from "./restart-terminal-recovery-session";
import {
  StartupGatedAttemptDispatcher,
  type StartupGatedAttemptComposition,
  type StartupGatedAttemptDispatchResult,
} from "./startup-gated-attempt-dispatcher";

export {
  LocalAttemptOwnerError,
  type LocalAttemptJournalConfiguration,
  type LocalAttemptOwnerOptions,
  type LocalAttemptSandboxOwner,
  type LocalAttemptSourceOwner,
  type LocalAttemptSpoolConfiguration,
} from "./local-attempt-owner-config";

export class LocalAttemptOwner {
  readonly #options: CapturedOptions;
  readonly #dispatcher: StartupGatedAttemptDispatcher;

  constructor(options: LocalAttemptOwnerOptions) {
    this.#options = captureLocalAttemptOwnerOptions(options);
    this.#dispatcher = new StartupGatedAttemptDispatcher({
      startup: new RunnerStartupRecoveryBarrier({
        sandboxes: this.#options.sandbox,
        sources: this.#options.sources,
      }),
      composition: Object.freeze({
        compose: async () => this.#compose(),
      }),
    });
  }

  dispatchNext(
    signal?: AbortSignal,
  ): Promise<StartupGatedAttemptDispatchResult> {
    return this.#dispatcher.dispatchNext(signal);
  }

  async #compose(): Promise<StartupGatedAttemptComposition> {
    const journal = await LocalWorkJournal.open(this.#options.journal);
    const spool = await LocalEventSpool.open(this.#options.spool);
    const sender = new SequentialSpoolSender(spool, this.#options.controlPlane);
    const completion = new WorkCompletionCoordinator(journal, spool);
    const recovery = new TerminalEvidenceRecoveryCoordinator(
      spool,
      sender,
      completion,
    );
    const auditor = new TerminalPublicationDispositionAuditor(journal, spool);
    const terminalEvidence = Object.freeze({
      audit: auditor.audit.bind(auditor),
      recover: recovery.recover.bind(recovery),
    });
    const admission = new WorkAdmissionCoordinator({
      journal,
      client: this.#options.controlPlane,
      leaseDurationMs: this.#options.leaseDurationMs,
      terminalEvidence,
    });
    return Object.freeze({
      admission,
      createFresh: (handoff) =>
        new FreshAttemptSession({
          admission: handoff,
          controlPlane: this.#options.controlPlane,
          scheduler: this.#options.scheduler,
          sandbox: this.#options.sandbox,
          journal,
          artifacts: this.#options.artifacts,
          images: this.#options.images,
          sources: this.#options.sources,
          requests: this.#options.requests,
          spool,
          recovery,
          executionPolicy: this.#options.executionPolicy,
          time: this.#options.time,
          runtime: this.#options.runtime,
          leaseDurationMs: this.#options.leaseDurationMs,
          heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
          revocationGracePeriodMs: this.#options.revocationGracePeriodMs,
          maximumRecoveryAttempts: this.#options.maximumRecoveryAttempts,
        }),
      createRestartRecovery: (handoff) =>
        new RestartTerminalRecoverySession({
          admission: handoff,
          controlPlane: this.#options.controlPlane,
          scheduler: this.#options.scheduler,
          sandbox: this.#options.sandbox,
          auditor,
          recovery,
          leaseDurationMs: this.#options.leaseDurationMs,
          heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
          revocationGracePeriodMs: this.#options.revocationGracePeriodMs,
          maximumRecoveryAttempts: this.#options.maximumRecoveryAttempts,
        }),
    });
  }
}
