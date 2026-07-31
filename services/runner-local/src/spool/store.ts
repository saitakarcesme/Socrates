import { randomUUID } from "node:crypto";

import {
  runnerEventAcknowledgementV1Schema,
  runnerExecutionV1Schema,
  type RunnerEventAcknowledgementV1,
  type RunnerEventV2,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import type { RunnerEventDraft } from "../lifecycle/draft";
import {
  attemptKeyFor,
  createCommit,
  createManifest,
  createSegment,
  decodeAcknowledgement,
  decodeCommit,
  decodeManifest,
  decodeSegment,
  encodeCanonical,
  executionDigestFor,
  immutableEvents,
} from "./codec";
import {
  spoolAcknowledgementStateSchema,
  spoolLimitsSchema,
  SpoolError,
  type SpoolAcknowledgementState,
  type SpoolCommit,
  type SpoolLimits,
  type SpoolManifest,
  type SpoolSegment,
  type SpoolState,
} from "./contracts";
import {
  SpoolFilesystem,
  type DirectorySync,
  type SpoolFaultInjector,
} from "./filesystem";

export type {
  DirectorySync,
  SpoolFaultInjector,
  SpoolFaultPoint,
} from "./filesystem";

const terminalEventTypes = new Set<RunnerEventV2["type"]>([
  "task.succeeded",
  "task.failed",
  "task.cancelled",
]);

export interface SpoolIdentitySource {
  eventId(): string;
  now(): Date;
}

export const systemSpoolIdentitySource: SpoolIdentitySource = Object.freeze({
  eventId: () => randomUUID(),
  now: () => new Date(),
});

type LoadedAttempt = Readonly<{
  manifest: SpoolManifest;
  commit: SpoolCommit | null;
  acknowledgement: SpoolAcknowledgementState | null;
  segments: readonly Readonly<{ name: string; value: SpoolSegment }>[];
  acknowledgedSequence: number;
  lastSequence: number;
  terminal: boolean;
}>;

function instant(source: SpoolIdentitySource): string {
  const value = source.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SpoolError(
      "corrupt",
      "The spool clock returned an invalid date.",
    );
  }
  return value.toISOString();
}

function segmentName(startSequence: number, endSequence: number): string {
  return `${String(startSequence).padStart(16, "0")}-${String(endSequence).padStart(16, "0")}.json`;
}

function sameAcknowledgement(
  left: RunnerEventAcknowledgementV1,
  right: RunnerEventAcknowledgementV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pendingFrom(state: LoadedAttempt): readonly RunnerEventV2[] {
  return immutableEvents(
    state.segments.flatMap(({ value }) =>
      value.events.filter(
        (event) => event.sequence > state.acknowledgedSequence,
      ),
    ),
  );
}

export class LocalEventSpool {
  readonly #filesystem: SpoolFilesystem;
  readonly #limits: SpoolLimits;
  readonly #identitySource: SpoolIdentitySource;
  #operationTail: Promise<void> = Promise.resolve();

  private constructor(options: {
    filesystem: SpoolFilesystem;
    limits: SpoolLimits;
    identitySource: SpoolIdentitySource;
  }) {
    this.#filesystem = options.filesystem;
    this.#limits = options.limits;
    this.#identitySource = options.identitySource;
  }

  static async open(options: {
    rootPath: string;
    limits: SpoolLimits;
    identitySource: SpoolIdentitySource;
    directorySync?: DirectorySync;
    injectFault?: SpoolFaultInjector;
  }): Promise<LocalEventSpool> {
    let limits: SpoolLimits;
    try {
      limits = Object.freeze(spoolLimitsSchema.parse(options.limits));
    } catch (cause) {
      throw new SpoolError(
        "invalid_configuration",
        "The spool limits are invalid.",
        { cause },
      );
    }
    const filesystem = new SpoolFilesystem({
      rootPath: options.rootPath,
      directorySync: options.directorySync,
      injectFault: options.injectFault,
    });
    await filesystem.initialize();
    const spool = new LocalEventSpool({
      filesystem,
      limits,
      identitySource: options.identitySource,
    });
    await spool.#validateRoot();
    return spool;
  }

  async append(
    input: RunnerExecutionV1,
    drafts: readonly RunnerEventDraft[],
  ): Promise<readonly RunnerEventV2[]> {
    const execution = runnerExecutionV1Schema.parse(input);
    const attemptKey = attemptKeyFor(execution);
    return this.#serialize(async () => {
      const state = await this.#openAttempt(execution);
      if (state.terminal) {
        throw new SpoolError(
          "terminal",
          "A terminal attempt cannot accept another event segment.",
        );
      }
      if (drafts.length < 1) {
        throw new RangeError(
          "A spool append requires at least one event draft.",
        );
      }
      if (state.lastSequence !== 0) {
        throw new SpoolError(
          "terminal",
          "A lifecycle attempt can contain only one committed segment.",
        );
      }
      const terminalDrafts = drafts.filter(({ type }) =>
        terminalEventTypes.has(type),
      );
      if (
        terminalDrafts.length !== 1 ||
        !terminalEventTypes.has(drafts.at(-1)!.type)
      ) {
        throw new SpoolError(
          "corrupt",
          "A lifecycle batch must end with exactly one terminal event.",
        );
      }
      if (drafts.length > this.#limits.maximumEventsPerSegment) {
        throw new SpoolError(
          "capacity_exceeded",
          "The event batch exceeds the configured segment event limit.",
        );
      }
      if (state.lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new SpoolError(
          "capacity_exceeded",
          "The attempt sequence is exhausted.",
        );
      }

      const segment = createSegment({
        execution,
        drafts,
        startSequence: state.lastSequence + 1,
        occurredAt: instant(this.#identitySource),
        eventIds: drafts.map(() => this.#identitySource.eventId()),
      });
      const bytes = encodeCanonical(segment);
      const name = segmentName(segment.startSequence, segment.endSequence);
      const commit = createCommit(segment, name);
      const commitBytes = encodeCanonical(commit);
      if (bytes.byteLength > this.#limits.maximumSegmentBytes) {
        throw new SpoolError(
          "capacity_exceeded",
          "The encoded event segment exceeds its byte limit.",
        );
      }
      const currentBytes = await this.#filesystem.totalBytes();
      if (
        (bytes.byteLength + commitBytes.byteLength) * 2 >
        this.#limits.maximumSpoolBytes - currentBytes
      ) {
        throw new SpoolError(
          "capacity_exceeded",
          "The event segment exceeds remaining spool capacity.",
        );
      }
      await this.#filesystem.publishSegment(attemptKey, name, bytes);
      await this.#filesystem.publishCommit(attemptKey, commitBytes);
      return immutableEvents(segment.events);
    });
  }

  async pending(input: RunnerExecutionV1): Promise<readonly RunnerEventV2[]> {
    const execution = runnerExecutionV1Schema.parse(input);
    return this.#serialize(async () =>
      pendingFrom(await this.#openAttempt(execution)),
    );
  }

  async acknowledge(
    input: RunnerExecutionV1,
    acknowledgementInput: RunnerEventAcknowledgementV1,
  ): Promise<SpoolState> {
    const execution = runnerExecutionV1Schema.parse(input);
    const acknowledgement =
      runnerEventAcknowledgementV1Schema.parse(acknowledgementInput);
    const attemptKey = attemptKeyFor(execution);
    return this.#serialize(async () => {
      const state = await this.#openAttempt(execution);
      const current = state.acknowledgement?.acknowledgement;
      if (current && sameAcknowledgement(current, acknowledgement)) {
        return this.#publicState(state);
      }
      if (acknowledgement.attemptId !== execution.lease.attemptId) {
        throw new SpoolError(
          "acknowledgement_conflict",
          "The acknowledgement belongs to another attempt.",
        );
      }
      const pending = pendingFrom(state);
      const next = pending[0];
      if (
        !next ||
        acknowledgement.acknowledgedSequence !== next.sequence ||
        acknowledgement.eventId !== next.eventId ||
        acknowledgement.expectedSequence !== next.sequence + 1
      ) {
        throw new SpoolError(
          "acknowledgement_conflict",
          "The acknowledgement does not match the first pending event.",
        );
      }

      const acknowledgementState = Object.freeze(
        spoolAcknowledgementStateSchema.parse({
          version: "1",
          acknowledgement,
          terminal: terminalEventTypes.has(next.type),
        }),
      );
      await this.#filesystem.replaceAcknowledgement(
        attemptKey,
        encodeCanonical(acknowledgementState),
      );
      for (const segment of state.segments) {
        if (segment.value.endSequence <= acknowledgement.acknowledgedSequence) {
          await this.#filesystem.deleteSegment(attemptKey, segment.name);
        }
      }
      return this.#publicState(await this.#loadAttempt(execution));
    });
  }

  async inspect(input: RunnerExecutionV1): Promise<SpoolState> {
    const execution = runnerExecutionV1Schema.parse(input);
    return this.#serialize(async () =>
      this.#publicState(await this.#openAttempt(execution)),
    );
  }

  async inspectExisting(input: RunnerExecutionV1): Promise<SpoolState | null> {
    const execution = runnerExecutionV1Schema.parse(input);
    const attemptKey = attemptKeyFor(execution);
    return this.#serialize(async () => {
      const existing = await this.#filesystem.listAttemptKeys();
      if (!existing.includes(attemptKey)) return null;
      return this.#publicState(await this.#loadAttempt(execution));
    });
  }

  async #validateRoot(): Promise<void> {
    const attempts = await this.#filesystem.listAttemptKeys();
    if (attempts.length > this.#limits.maximumAttempts) {
      throw new SpoolError(
        "capacity_exceeded",
        "The spool contains more attempts than configured.",
      );
    }
    if (
      (await this.#filesystem.totalBytes()) > this.#limits.maximumSpoolBytes
    ) {
      throw new SpoolError(
        "capacity_exceeded",
        "The spool exceeds its configured byte capacity.",
      );
    }
  }

  async #openAttempt(execution: RunnerExecutionV1): Promise<LoadedAttempt> {
    const attemptKey = attemptKeyFor(execution);
    const existing = await this.#filesystem.listAttemptKeys();
    const attemptExists = existing.includes(attemptKey);
    let manifestBytes: Uint8Array | null = null;
    if (!attemptExists) {
      if (existing.length >= this.#limits.maximumAttempts) {
        throw new SpoolError(
          "capacity_exceeded",
          "The spool attempt capacity is exhausted.",
        );
      }
      manifestBytes = encodeCanonical(
        createManifest(execution, instant(this.#identitySource)),
      );
      const currentBytes = await this.#filesystem.totalBytes();
      if (
        manifestBytes.byteLength * 2 >
        this.#limits.maximumSpoolBytes - currentBytes
      ) {
        throw new SpoolError(
          "capacity_exceeded",
          "The attempt manifest exceeds remaining spool capacity.",
        );
      }
    }
    await this.#filesystem.ensureAttempt(attemptKey);
    await this.#filesystem.cleanupAttemptTemporary(attemptKey);
    const durableManifest = await this.#filesystem.readManifest(attemptKey);
    if (!durableManifest) {
      if (
        (await this.#filesystem.readAcknowledgement(attemptKey)) ||
        (await this.#filesystem.readCommit(attemptKey)) ||
        (await this.#filesystem.listSegmentNames(attemptKey)).length > 0
      ) {
        throw new SpoolError(
          "corrupt",
          "A spool attempt contains evidence without a manifest.",
        );
      }
      manifestBytes ??= encodeCanonical(
        createManifest(execution, instant(this.#identitySource)),
      );
      await this.#filesystem.publishManifest(attemptKey, manifestBytes);
    }
    return this.#loadAttempt(execution);
  }

  async #loadAttempt(execution: RunnerExecutionV1): Promise<LoadedAttempt> {
    const attemptKey = attemptKeyFor(execution);
    await this.#filesystem.cleanupAttemptTemporary(attemptKey);
    const manifestBytes = await this.#filesystem.readManifest(attemptKey);
    if (!manifestBytes) {
      throw new SpoolError("corrupt", "The spool attempt has no manifest.");
    }
    const manifest = decodeManifest(manifestBytes);
    if (
      manifest.attemptKey !== attemptKey ||
      manifest.executionDigest !== executionDigestFor(execution)
    ) {
      throw new SpoolError(
        "identity_conflict",
        "The spool manifest does not match the frozen execution.",
      );
    }
    const acknowledgementBytes =
      await this.#filesystem.readAcknowledgement(attemptKey);
    const acknowledgement = acknowledgementBytes
      ? decodeAcknowledgement(acknowledgementBytes)
      : null;
    const acknowledgedSequence =
      acknowledgement?.acknowledgement.acknowledgedSequence ?? 0;
    const commitBytes = await this.#filesystem.readCommit(attemptKey);
    let commit = commitBytes ? decodeCommit(commitBytes) : null;

    const segments: { name: string; value: SpoolSegment }[] = [];
    for (const name of await this.#filesystem.listSegmentNames(attemptKey)) {
      const value = decodeSegment(
        await this.#filesystem.readSegment(attemptKey, name),
      );
      if (
        value.attemptKey !== attemptKey ||
        name !== segmentName(value.startSequence, value.endSequence)
      ) {
        throw new SpoolError(
          "corrupt",
          "A spool segment identity or range filename does not match.",
        );
      }
      for (const event of value.events) {
        if (
          event.runnerId !== manifest.identity.runnerId ||
          event.taskId !== manifest.identity.taskId ||
          event.attemptId !== manifest.identity.attemptId ||
          event.fence !== manifest.identity.fence
        ) {
          throw new SpoolError(
            "identity_conflict",
            "A spool event does not match its attempt manifest.",
          );
        }
      }
      segments.push({ name, value });
    }

    if (segments.length > 1) {
      throw new SpoolError(
        "corrupt",
        "A lifecycle spool attempt can contain only one segment.",
      );
    }
    const allEvents = segments.flatMap(({ value }) => value.events);
    if (
      new Set(allEvents.map(({ eventId }) => eventId)).size !== allEvents.length
    ) {
      throw new SpoolError("corrupt", "Spool event IDs are not unique.");
    }
    const terminalIndexes = allEvents
      .map((event, index) => (terminalEventTypes.has(event.type) ? index : -1))
      .filter((index) => index >= 0);
    if (
      segments.length === 1 &&
      (segments[0]!.value.startSequence !== 1 ||
        terminalIndexes.length !== 1 ||
        terminalIndexes[0] !== allEvents.length - 1)
    ) {
      throw new SpoolError(
        "corrupt",
        "A lifecycle segment must start at one and end with one terminal event.",
      );
    }

    const segment = segments[0];
    if (!commit && segment) {
      const recovered = createCommit(segment.value, segment.name);
      const recoveredBytes = encodeCanonical(recovered);
      const currentBytes = await this.#filesystem.totalBytes();
      if (
        recoveredBytes.byteLength * 2 >
        this.#limits.maximumSpoolBytes - currentBytes
      ) {
        throw new SpoolError(
          "capacity_exceeded",
          "The recovered commit marker exceeds remaining spool capacity.",
        );
      }
      await this.#filesystem.publishCommit(attemptKey, recoveredBytes);
      commit = recovered;
    }

    if (commit) {
      if (commit.attemptKey !== attemptKey) {
        throw new SpoolError(
          "identity_conflict",
          "The commit marker belongs to another attempt.",
        );
      }
      if (segment) {
        if (
          commit.segmentName !== segment.name ||
          commit.segmentChecksum !== segment.value.checksum ||
          commit.startSequence !== segment.value.startSequence ||
          commit.endSequence !== segment.value.endSequence ||
          commit.terminalEventId !== segment.value.events.at(-1)?.eventId
        ) {
          throw new SpoolError(
            "corrupt",
            "The commit marker does not match its segment.",
          );
        }
      } else if (
        !acknowledgement?.terminal ||
        acknowledgedSequence !== commit.endSequence ||
        acknowledgement.acknowledgement.eventId !== commit.terminalEventId
      ) {
        throw new SpoolError(
          "corrupt",
          "A committed unacknowledged segment is missing.",
        );
      }
    } else if (acknowledgement) {
      throw new SpoolError(
        "corrupt",
        "An acknowledgement exists without a committed lifecycle batch.",
      );
    }

    const lastSequence = commit?.endSequence ?? 0;
    if (acknowledgedSequence > lastSequence) {
      throw new SpoolError(
        "corrupt",
        "The acknowledgement cursor exceeds committed evidence.",
      );
    }
    const acknowledgedEvent = allEvents.find(
      ({ sequence }) => sequence === acknowledgedSequence,
    );
    if (
      acknowledgedEvent &&
      (acknowledgedEvent.eventId !== acknowledgement?.acknowledgement.eventId ||
        acknowledgement?.terminal !==
          terminalEventTypes.has(acknowledgedEvent.type))
    ) {
      throw new SpoolError(
        "corrupt",
        "The acknowledgement conflicts with durable evidence.",
      );
    }
    if (
      acknowledgement?.terminal &&
      (acknowledgedSequence !== lastSequence ||
        acknowledgement.acknowledgement.eventId !== commit?.terminalEventId)
    ) {
      throw new SpoolError(
        "corrupt",
        "A terminal acknowledgement cannot precede durable events.",
      );
    }

    return Object.freeze({
      manifest,
      commit,
      acknowledgement,
      segments: Object.freeze(segments),
      acknowledgedSequence,
      lastSequence,
      terminal: commit !== null,
    });
  }

  #publicState(state: LoadedAttempt): SpoolState {
    return Object.freeze({
      attemptKey: state.manifest.attemptKey,
      acknowledgedSequence: state.acknowledgedSequence,
      lastSequence: state.lastSequence,
      pendingEvents: pendingFrom(state).length,
      terminal: state.terminal,
    });
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
