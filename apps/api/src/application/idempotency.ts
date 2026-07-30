import { createHash } from "node:crypto";

import type {
  JsonValue,
  Persistence,
  TransactionRepositories,
} from "@socrates/database";

import { CommandError } from "./errors";

export type CommandResponse = {
  status: number;
  body: JsonValue;
};

export type ExecutedCommand = CommandResponse & {
  replayed: boolean;
};

export type CommittedCommand = {
  commandName: string;
  response: CommandResponse;
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

export class IdempotentCommandExecutor {
  constructor(
    private readonly persistence: Persistence,
    private readonly onCommitted?: (
      command: CommittedCommand,
    ) => void | Promise<void>,
  ) {}

  async execute(
    input: {
      workspaceId: string;
      key: string;
      commandName: string;
      body: unknown;
    },
    work: (repositories: TransactionRepositories) => Promise<CommandResponse>,
  ): Promise<ExecutedCommand> {
    const result = await this.persistence.transaction(async (repositories) => {
      const claimInput = {
        workspaceId: input.workspaceId,
        key: input.key,
        commandName: input.commandName,
        requestHash: requestHash(input.body),
      };
      const claim = await repositories.idempotency.claim(claimInput);

      if (claim.state === "conflict") {
        throw new CommandError(
          409,
          "idempotency_conflict",
          "The idempotency key was already used for a different request.",
        );
      }

      if (claim.state === "in_progress") {
        throw new CommandError(
          409,
          "idempotency_conflict",
          "A request with this idempotency key is still in progress.",
        );
      }

      if (claim.state === "replay") {
        return { ...claim.response, replayed: true };
      }

      const response = await work(repositories);
      await repositories.idempotency.complete(claimInput, response);

      return { ...response, replayed: false };
    });

    if (!result.replayed && this.onCommitted) {
      try {
        await this.onCommitted({
          commandName: input.commandName,
          response: { status: result.status, body: result.body },
        });
      } catch (error) {
        console.error("Post-commit notification failed.", error);
      }
    }

    return result;
  }
}
