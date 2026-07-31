export interface SandboxOwnedResourceRecoveryPort {
  recoverOwned(): Promise<number>;
}

export interface SourceOwnedResourceRecoveryPort {
  recoverOwned(): Promise<number>;
}

export type RunnerStartupRecoveryResult = Readonly<{
  sandboxesRemoved: number;
  sourcesRemoved: number;
}>;

export class RunnerStartupRecoveryError extends Error {
  constructor(
    readonly code:
      "invalid_result" | "sandbox_recovery_failed" | "source_recovery_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerStartupRecoveryError";
  }
}

function removedCount(stage: "sandbox" | "source", value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RunnerStartupRecoveryError(
      "invalid_result",
      `${stage} recovery returned an invalid removed-resource count.`,
    );
  }
  return value;
}

export class RunnerStartupRecoveryBarrier {
  readonly #sandboxes: SandboxOwnedResourceRecoveryPort;
  readonly #sources: SourceOwnedResourceRecoveryPort;
  #recovery: Promise<RunnerStartupRecoveryResult> | undefined;

  constructor(options: {
    sandboxes: SandboxOwnedResourceRecoveryPort;
    sources: SourceOwnedResourceRecoveryPort;
  }) {
    this.#sandboxes = options.sandboxes;
    this.#sources = options.sources;
  }

  recover(): Promise<RunnerStartupRecoveryResult> {
    this.#recovery ??= this.#recover();
    return this.#recovery;
  }

  async #recover(): Promise<RunnerStartupRecoveryResult> {
    let sandboxResult: number;
    try {
      sandboxResult = await this.#sandboxes.recoverOwned();
    } catch (cause) {
      throw new RunnerStartupRecoveryError(
        "sandbox_recovery_failed",
        "Owned sandbox recovery failed.",
        { cause },
      );
    }
    const sandboxesRemoved = removedCount("sandbox", sandboxResult);

    let sourceResult: number;
    try {
      sourceResult = await this.#sources.recoverOwned();
    } catch (cause) {
      throw new RunnerStartupRecoveryError(
        "source_recovery_failed",
        "Owned source recovery failed.",
        { cause },
      );
    }
    const sourcesRemoved = removedCount("source", sourceResult);

    return Object.freeze({ sandboxesRemoved, sourcesRemoved });
  }
}
