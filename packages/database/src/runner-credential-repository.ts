import { eq, sql } from "drizzle-orm";

import type { Database } from "./database-types";
import type {
  ProvisionRunnerCredentialInput,
  ProvisionRunnerCredentialResult,
  RunnerCredentialCandidate,
  RunnerCredentialRepository,
} from "./ports";
import * as schema from "./schema/index";

export class PostgresRunnerCredentialRepository implements RunnerCredentialRepository {
  constructor(private readonly database: Database) {}

  async findCandidate(
    tokenId: string,
  ): Promise<RunnerCredentialCandidate | null> {
    const [candidate] = await this.database
      .select({
        tokenId: schema.runnerRegistrationTokens.id,
        runnerId: schema.runnerRegistrationTokens.runnerId,
        workspaceId: schema.runnerRegistrations.workspaceId,
        secretDigest: schema.runnerRegistrationTokens.secretDigest,
        usable: sql<boolean>`${schema.runnerRegistrationTokens.revokedAt} IS NULL AND ${schema.runnerRegistrationTokens.expiresAt} > CURRENT_TIMESTAMP`,
      })
      .from(schema.runnerRegistrationTokens)
      .innerJoin(
        schema.runnerRegistrations,
        eq(
          schema.runnerRegistrations.id,
          schema.runnerRegistrationTokens.runnerId,
        ),
      )
      .where(eq(schema.runnerRegistrationTokens.id, tokenId))
      .limit(1);

    return candidate ?? null;
  }

  async provision(
    input: ProvisionRunnerCredentialInput,
  ): Promise<ProvisionRunnerCredentialResult> {
    return this.database.transaction(async (transaction) => {
      const [runner] = await transaction
        .select({ id: schema.runnerRegistrations.id })
        .from(schema.runnerRegistrations)
        .where(eq(schema.runnerRegistrations.id, input.runnerId))
        .for("update");
      if (!runner) return { state: "runner_not_found" };

      const [created] = await transaction
        .insert(schema.runnerRegistrationTokens)
        .values({
          id: input.tokenId,
          runnerId: input.runnerId,
          secretDigest: input.secretDigest,
          label: input.label,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.runnerRegistrationTokens.id });

      return created ? { state: "created" } : { state: "token_conflict" };
    });
  }
}
