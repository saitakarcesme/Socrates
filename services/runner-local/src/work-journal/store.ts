import { randomUUID } from "node:crypto";

import {
  runnerExecutionV1Schema,
  runnerTaskDeliveryV1Schema,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import {
  createWorkClaim,
  createWorkCompletion,
  createWorkManifest,
  createWorkRejection,
  decodeWorkClaim,
  decodeWorkCompletion,
  decodeWorkManifest,
  decodeWorkRejection,
  deliveryKeyFor,
  encodeWorkRecord,
  executionDigestFor,
  immutableExecution,
} from "./codec";
import {
  workJournalLimitsSchema,
  workCompletionCoreSchema,
  workRejectionCoreSchema,
  WorkJournalError,
  type WorkClaim,
  type WorkCompletion,
  type WorkJournalLimits,
  type WorkJournalState,
  type WorkManifest,
  type WorkRejection,
  type WorkRejectionCore,
} from "./contracts";
import {
  WorkJournalFilesystem,
  type DirectorySync,
  type WorkJournalFaultInjector,
} from "./filesystem";

export type {
  DirectorySync,
  WorkJournalFaultInjector,
  WorkJournalFaultPoint,
} from "./filesystem";

export interface WorkJournalIdentitySource {
  attemptId(): string;
  now(): Date;
}

export const systemWorkJournalIdentitySource: WorkJournalIdentitySource =
  Object.freeze({
    attemptId: () => randomUUID(),
    now: () => new Date(),
  });

type LoadedWork = Readonly<{
  manifest: WorkManifest;
  claim: WorkClaim | null;
  completion: WorkCompletion | null;
  rejection: WorkRejection | null;
}>;

export class LocalWorkJournal {
  readonly #filesystem: WorkJournalFilesystem;
  readonly #limits: WorkJournalLimits;
  readonly #identitySource: WorkJournalIdentitySource;
  #operationTail: Promise<void> = Promise.resolve();

  private constructor(options: {
    filesystem: WorkJournalFilesystem;
    limits: WorkJournalLimits;
    identitySource: WorkJournalIdentitySource;
  }) {
    this.#filesystem = options.filesystem;
    this.#limits = options.limits;
    this.#identitySource = options.identitySource;
  }

  static async open(options: {
    rootPath: string;
    limits: WorkJournalLimits;
    identitySource?: WorkJournalIdentitySource;
    directorySync?: DirectorySync;
    injectFault?: WorkJournalFaultInjector;
  }): Promise<LocalWorkJournal> {
    let limits: WorkJournalLimits;
    try {
      limits = Object.freeze(workJournalLimitsSchema.parse(options.limits));
    } catch (cause) {
      throw new WorkJournalError(
        "invalid_configuration",
        "Work journal limits are invalid.",
        { cause },
      );
    }
    const filesystem = new WorkJournalFilesystem(options);
    await filesystem.initialize();
    const journal = new LocalWorkJournal({
      filesystem,
      limits,
      identitySource: options.identitySource ?? systemWorkJournalIdentitySource,
    });
    await journal.#validateRoot();
    return journal;
  }

  async admit(input: RunnerTaskDeliveryV1): Promise<WorkJournalState> {
    const delivery = runnerTaskDeliveryV1Schema.parse(input);
    return this.#serialize(async () => {
      const key = deliveryKeyFor(delivery);
      const keys = await this.#filesystem.listKeys();
      if (!keys.includes(key)) {
        if (keys.length >= this.#limits.maximumItems) {
          throw new WorkJournalError(
            "capacity_exceeded",
            "Work journal item capacity is exhausted.",
          );
        }
        await this.#filesystem.ensureItem(key);
      }
      await this.#filesystem.cleanup(key);
      const existing = await this.#filesystem.readManifest(key);
      if (!existing) {
        if (
          (await this.#filesystem.readClaim(key)) ||
          (await this.#filesystem.readRejection(key)) ||
          (await this.#filesystem.readCompletion(key))
        ) {
          throw new WorkJournalError(
            "corrupt",
            "A terminal work record exists without a manifest.",
          );
        }
        const manifest = createWorkManifest({
          delivery,
          attemptId: this.#identitySource.attemptId(),
          admittedAt: this.#instant(),
        });
        const bytes = encodeWorkRecord(manifest);
        await this.#checkCapacity(
          bytes.byteLength,
          this.#limits.maximumManifestBytes,
          "manifest",
        );
        await this.#filesystem.publishManifest(key, bytes);
      }
      const loaded = await this.#load(key);
      this.#requireDelivery(loaded.manifest, delivery);
      return this.#state(loaded);
    });
  }

  async inspect(deliveryId: string): Promise<WorkJournalState | null> {
    const parsed =
      runnerTaskDeliveryV1Schema.shape.deliveryId.parse(deliveryId);
    return this.#serialize(async () => {
      const key = deliveryKeyFor({
        version: "1",
        deliveryId: parsed,
        taskId: parsed,
      });
      if (!(await this.#filesystem.listKeys()).includes(key)) return null;
      return this.#state(await this.#load(key));
    });
  }

  async list(): Promise<readonly WorkJournalState[]> {
    return this.#serialize(async () => {
      const states: WorkJournalState[] = [];
      for (const key of await this.#filesystem.listKeys()) {
        await this.#filesystem.cleanup(key);
        if (!(await this.#filesystem.readManifest(key))) {
          if (
            (await this.#filesystem.readClaim(key)) ||
            (await this.#filesystem.readRejection(key)) ||
            (await this.#filesystem.readCompletion(key))
          ) {
            throw new WorkJournalError(
              "corrupt",
              "A terminal work record exists without a manifest.",
            );
          }
          continue;
        }
        states.push(this.#state(await this.#load(key)));
      }
      return Object.freeze(states);
    });
  }

  async claimedExecution(
    deliveryId: string,
  ): Promise<RunnerExecutionV1 | null> {
    const state = await this.#loadByDeliveryId(deliveryId);
    return state?.claim ? immutableExecution(state.claim.execution) : null;
  }

  async commitClaim(
    deliveryId: string,
    input: RunnerExecutionV1,
  ): Promise<RunnerExecutionV1> {
    const execution = runnerExecutionV1Schema.parse(input);
    return this.#serialize(async () => {
      const loaded = await this.#requireByDeliveryId(deliveryId);
      const { manifest } = loaded;
      if (
        execution.lease.taskId !== manifest.identity.taskId ||
        execution.lease.attemptId !== manifest.identity.attemptId
      ) {
        throw new WorkJournalError(
          "identity_conflict",
          "Claim execution does not match the durable delivery identity.",
        );
      }
      if (loaded.claim) {
        if (loaded.claim.executionDigest !== executionDigestFor(execution)) {
          throw new WorkJournalError(
            "identity_conflict",
            "A different execution conflicts with the durable work claim.",
          );
        }
        return immutableExecution(loaded.claim.execution);
      }
      if (loaded.rejection) {
        throw new WorkJournalError(
          "identity_conflict",
          "A rejected work item cannot become claimed.",
        );
      }
      const claim = createWorkClaim({
        deliveryKey: manifest.deliveryKey,
        execution,
        committedAt: this.#instant(),
      });
      const bytes = encodeWorkRecord(claim);
      await this.#checkCapacity(
        bytes.byteLength,
        this.#limits.maximumClaimBytes,
        "claim",
      );
      await this.#filesystem.publishClaim(manifest.deliveryKey, bytes);
      const durable = await this.#load(manifest.deliveryKey);
      if (!durable.claim)
        throw new WorkJournalError(
          "corrupt",
          "The durable work claim is missing after publication.",
        );
      return immutableExecution(durable.claim.execution);
    });
  }

  async commitRejection(
    deliveryId: string,
    response: WorkRejectionCore["response"],
  ): Promise<WorkJournalState> {
    const parsedResponse =
      workRejectionCoreSchema.shape.response.parse(response);
    return this.#serialize(async () => {
      const loaded = await this.#requireByDeliveryId(deliveryId);
      if (loaded.claim) {
        throw new WorkJournalError(
          "identity_conflict",
          "A claimed work item cannot become rejected.",
        );
      }
      if (loaded.rejection) {
        if (
          canonicalJson(loaded.rejection.response) !==
          canonicalJson(parsedResponse)
        ) {
          throw new WorkJournalError(
            "identity_conflict",
            "Different control-plane conflicts target one delivery.",
          );
        }
        return this.#state(loaded);
      }
      const rejection = createWorkRejection({
        deliveryKey: loaded.manifest.deliveryKey,
        response: parsedResponse,
        committedAt: this.#instant(),
      });
      const bytes = encodeWorkRecord(rejection);
      await this.#checkCapacity(
        bytes.byteLength,
        this.#limits.maximumClaimBytes,
        "rejection",
      );
      await this.#filesystem.publishRejection(
        loaded.manifest.deliveryKey,
        bytes,
      );
      return this.#state(await this.#load(loaded.manifest.deliveryKey));
    });
  }

  async commitCompletion(
    deliveryId: string,
    executionInput: RunnerExecutionV1,
    evidence: { attemptKey: string; acknowledgedSequence: number },
  ): Promise<WorkJournalState> {
    const execution = runnerExecutionV1Schema.parse(executionInput);
    const attemptKey = workCompletionCoreSchema.shape.attemptKey.parse(
      evidence.attemptKey,
    );
    const acknowledgedSequence =
      workCompletionCoreSchema.shape.acknowledgedSequence.parse(
        evidence.acknowledgedSequence,
      );
    return this.#serialize(async () => {
      const loaded = await this.#requireByDeliveryId(deliveryId);
      if (!loaded.claim) {
        throw new WorkJournalError(
          "identity_conflict",
          "Work cannot complete without a durable claim.",
        );
      }
      if (loaded.rejection) {
        throw new WorkJournalError(
          "identity_conflict",
          "Rejected work cannot become completed.",
        );
      }
      const executionDigest = executionDigestFor(execution);
      if (loaded.claim.executionDigest !== executionDigest) {
        throw new WorkJournalError(
          "identity_conflict",
          "Completion execution does not match the durable claim.",
        );
      }
      if (loaded.completion) {
        if (
          loaded.completion.executionDigest !== executionDigest ||
          loaded.completion.attemptKey !== attemptKey ||
          loaded.completion.acknowledgedSequence !== acknowledgedSequence
        ) {
          throw new WorkJournalError(
            "identity_conflict",
            "Different completion evidence conflicts with this delivery.",
          );
        }
        return this.#state(loaded);
      }
      const completion = createWorkCompletion({
        deliveryKey: loaded.manifest.deliveryKey,
        execution,
        attemptKey,
        acknowledgedSequence,
        committedAt: this.#instant(),
      });
      const bytes = encodeWorkRecord(completion);
      await this.#checkCapacity(
        bytes.byteLength,
        this.#limits.maximumClaimBytes,
        "completion",
      );
      await this.#filesystem.publishCompletion(
        loaded.manifest.deliveryKey,
        bytes,
      );
      return this.#state(await this.#load(loaded.manifest.deliveryKey));
    });
  }

  async #loadByDeliveryId(deliveryId: string): Promise<LoadedWork | null> {
    const parsed =
      runnerTaskDeliveryV1Schema.shape.deliveryId.parse(deliveryId);
    return this.#serialize(async () => {
      const key = deliveryKeyFor({
        version: "1",
        deliveryId: parsed,
        taskId: parsed,
      });
      if (!(await this.#filesystem.listKeys()).includes(key)) return null;
      return this.#load(key);
    });
  }

  async #requireByDeliveryId(deliveryId: string): Promise<LoadedWork> {
    const parsed =
      runnerTaskDeliveryV1Schema.shape.deliveryId.parse(deliveryId);
    const key = deliveryKeyFor({
      version: "1",
      deliveryId: parsed,
      taskId: parsed,
    });
    if (!(await this.#filesystem.listKeys()).includes(key)) {
      throw new WorkJournalError(
        "identity_conflict",
        "The delivery is not admitted in this work journal.",
      );
    }
    return this.#load(key);
  }

  async #load(key: string): Promise<LoadedWork> {
    await this.#filesystem.cleanup(key);
    const manifestBytes = await this.#filesystem.readManifest(key);
    if (!manifestBytes) {
      if (
        (await this.#filesystem.readClaim(key)) ||
        (await this.#filesystem.readRejection(key)) ||
        (await this.#filesystem.readCompletion(key))
      )
        throw new WorkJournalError(
          "corrupt",
          "A terminal work record exists without a manifest.",
        );
      throw new WorkJournalError(
        "corrupt",
        "A work journal item has no manifest.",
      );
    }
    const manifest = decodeWorkManifest(manifestBytes);
    if (
      manifest.deliveryKey !== key ||
      deliveryKeyFor({
        version: "1",
        deliveryId: manifest.identity.deliveryId,
        taskId: manifest.identity.taskId,
      }) !== key
    )
      throw new WorkJournalError(
        "identity_conflict",
        "Work manifest identity does not match its delivery key.",
      );
    const claimBytes = await this.#filesystem.readClaim(key);
    const claim = claimBytes ? decodeWorkClaim(claimBytes) : null;
    const rejectionBytes = await this.#filesystem.readRejection(key);
    const rejection = rejectionBytes
      ? decodeWorkRejection(rejectionBytes)
      : null;
    const completionBytes = await this.#filesystem.readCompletion(key);
    const completion = completionBytes
      ? decodeWorkCompletion(completionBytes)
      : null;
    if (claim && rejection)
      throw new WorkJournalError(
        "corrupt",
        "A work item cannot contain both claim and rejection records.",
      );
    if (completion && (!claim || rejection))
      throw new WorkJournalError(
        "corrupt",
        "Work completion requires a claim and forbids rejection.",
      );
    if (
      claim &&
      (claim.deliveryKey !== key ||
        claim.execution.lease.taskId !== manifest.identity.taskId ||
        claim.execution.lease.attemptId !== manifest.identity.attemptId)
    )
      throw new WorkJournalError(
        "identity_conflict",
        "Work claim identity does not match its manifest.",
      );
    if (rejection && rejection.deliveryKey !== key)
      throw new WorkJournalError(
        "identity_conflict",
        "Work rejection identity does not match its manifest.",
      );
    if (
      completion &&
      (completion.deliveryKey !== key ||
        completion.executionDigest !== claim?.executionDigest)
    )
      throw new WorkJournalError(
        "identity_conflict",
        "Work completion identity does not match its claim.",
      );
    return Object.freeze({ manifest, claim, completion, rejection });
  }

  #requireDelivery(
    manifest: WorkManifest,
    delivery: RunnerTaskDeliveryV1,
  ): void {
    if (
      manifest.identity.deliveryId !== delivery.deliveryId ||
      manifest.identity.taskId !== delivery.taskId
    ) {
      throw new WorkJournalError(
        "identity_conflict",
        "A delivery ID was reused for a different task.",
      );
    }
  }

  #state(loaded: LoadedWork): WorkJournalState {
    return Object.freeze({
      deliveryId: loaded.manifest.identity.deliveryId,
      taskId: loaded.manifest.identity.taskId,
      attemptId: loaded.manifest.identity.attemptId,
      state: loaded.completion
        ? "completed"
        : loaded.claim
          ? "claimed"
          : loaded.rejection
            ? "rejected"
            : "pending_claim",
      admittedAt: loaded.manifest.admittedAt,
      ...(loaded.claim ? { claimedAt: loaded.claim.committedAt } : {}),
      ...(loaded.rejection
        ? {
            rejectedAt: loaded.rejection.committedAt,
            rejection: {
              reason: loaded.rejection.reason,
              ...loaded.rejection.response,
            },
          }
        : {}),
      ...(loaded.completion
        ? {
            completedAt: loaded.completion.committedAt,
            completion: {
              attemptKey: loaded.completion.attemptKey,
              acknowledgedSequence: loaded.completion.acknowledgedSequence,
            },
          }
        : {}),
    });
  }

  async #checkCapacity(
    bytes: number,
    recordLimit: number,
    label: string,
  ): Promise<void> {
    if (bytes > recordLimit)
      throw new WorkJournalError(
        "capacity_exceeded",
        `The work ${label} exceeds its record byte limit.`,
      );
    const current = await this.#filesystem.totalBytes();
    if (bytes * 2 > this.#limits.maximumJournalBytes - current) {
      throw new WorkJournalError(
        "capacity_exceeded",
        `The work ${label} exceeds remaining journal capacity.`,
      );
    }
  }

  async #validateRoot(): Promise<void> {
    const keys = await this.#filesystem.listKeys();
    if (keys.length > this.#limits.maximumItems)
      throw new WorkJournalError(
        "capacity_exceeded",
        "The work journal contains too many items.",
      );
    if (
      (await this.#filesystem.totalBytes()) > this.#limits.maximumJournalBytes
    )
      throw new WorkJournalError(
        "capacity_exceeded",
        "The work journal exceeds its byte capacity.",
      );
    for (const key of keys) {
      await this.#filesystem.cleanup(key);
      if (!(await this.#filesystem.readManifest(key))) {
        if (
          (await this.#filesystem.readClaim(key)) ||
          (await this.#filesystem.readRejection(key)) ||
          (await this.#filesystem.readCompletion(key))
        ) {
          throw new WorkJournalError(
            "corrupt",
            "A terminal work record exists without a manifest.",
          );
        }
        continue;
      }
      await this.#load(key);
    }
  }

  #instant(): string {
    const value = this.#identitySource.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new WorkJournalError(
        "corrupt",
        "The work journal clock returned an invalid date.",
      );
    }
    return value.toISOString();
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#operationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
