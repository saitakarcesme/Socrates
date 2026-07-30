import { and, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { PostgresCommandRepository } from "./command-repository";
import type { DatabaseTransaction } from "./database-types";
import { PostgresReadRepository } from "./read-repository";
import { PostgresSchedulerRepository } from "./scheduler-repository";
import type {
  AppendRunEventInput,
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyRepository,
  IdempotencyResponse,
  JsonValue,
  Persistence,
  RunEventRecord,
  RunEventRepository,
  TransactionRepositories,
} from "./ports";
import * as schema from "./schema/index";

class PostgresIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly transaction: DatabaseTransaction) {}

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const inserted = await this.transaction
      .insert(schema.idempotencyKeys)
      .values(input)
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });

    if (inserted.length === 1) {
      return { state: "claimed" };
    }

    const [existing] = await this.transaction
      .select({
        commandName: schema.idempotencyKeys.commandName,
        requestHash: schema.idempotencyKeys.requestHash,
        responseStatus: schema.idempotencyKeys.responseStatus,
        responseBody: schema.idempotencyKeys.responseBody,
      })
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.workspaceId, input.workspaceId),
          eq(schema.idempotencyKeys.key, input.key),
        ),
      )
      .for("update");

    if (!existing) {
      throw new Error("Idempotency claim disappeared inside the transaction.");
    }

    if (
      existing.commandName !== input.commandName ||
      existing.requestHash !== input.requestHash
    ) {
      return { state: "conflict" };
    }

    if (existing.responseStatus === null || existing.responseBody === null) {
      return { state: "in_progress" };
    }

    return {
      state: "replay",
      response: {
        status: existing.responseStatus,
        body: existing.responseBody as JsonValue,
      },
    };
  }

  async complete(
    input: IdempotencyClaimInput,
    response: IdempotencyResponse,
  ): Promise<void> {
    const [completed] = await this.transaction
      .update(schema.idempotencyKeys)
      .set({
        responseStatus: response.status,
        responseBody: response.body,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.idempotencyKeys.workspaceId, input.workspaceId),
          eq(schema.idempotencyKeys.key, input.key),
          eq(schema.idempotencyKeys.commandName, input.commandName),
          eq(schema.idempotencyKeys.requestHash, input.requestHash),
          isNull(schema.idempotencyKeys.responseStatus),
        ),
      )
      .returning({ key: schema.idempotencyKeys.key });

    if (!completed) {
      throw new Error("Idempotency claim cannot be completed.");
    }
  }
}

class PostgresRunEventRepository implements RunEventRepository {
  constructor(private readonly transaction: DatabaseTransaction) {}

  async append(input: AppendRunEventInput): Promise<RunEventRecord> {
    const [run] = await this.transaction
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.id, input.runId))
      .for("update");

    if (!run) {
      throw new Error(`Run ${input.runId} does not exist.`);
    }

    const [cursor] = await this.transaction
      .select({ value: max(schema.runEvents.sequence) })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, input.runId));
    const sequence = (cursor?.value ?? 0) + 1;

    const [event] = await this.transaction
      .insert(schema.runEvents)
      .values({
        runId: input.runId,
        sequence,
        type: input.type,
        schemaVersion: input.schemaVersion,
        payload: input.payload,
        occurredAt: input.occurredAt,
      })
      .returning();

    if (!event) {
      throw new Error("Run event insert returned no record.");
    }

    return {
      ...event,
      payload: event.payload as JsonValue,
    };
  }
}

function createRepositories(
  transaction: DatabaseTransaction,
): TransactionRepositories {
  return {
    commands: new PostgresCommandRepository(transaction),
    idempotency: new PostgresIdempotencyRepository(transaction),
    runEvents: new PostgresRunEventRepository(transaction),
    scheduler: new PostgresSchedulerRepository(transaction),
  };
}

export type PersistenceOptions = {
  connectionString: string;
  maximumConnections?: number;
};

export function createPersistence(options: PersistenceOptions): Persistence {
  const client = postgres(options.connectionString, {
    max: options.maximumConnections ?? 10,
  });
  const database = drizzle(client, { schema });

  return {
    reads: new PostgresReadRepository(database),
    transaction: (work) =>
      database.transaction((transaction) =>
        work(createRepositories(transaction)),
      ),
    close: () => client.end(),
  };
}
