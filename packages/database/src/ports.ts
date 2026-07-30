export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type IdempotencyClaimInput = {
  workspaceId: string;
  key: string;
  commandName: string;
  requestHash: string;
};

export type IdempotencyResponse = {
  status: number;
  body: JsonValue;
};

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "in_progress" }
  | { state: "conflict" }
  | { state: "replay"; response: IdempotencyResponse };

export interface IdempotencyRepository {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim>;
  complete(
    input: IdempotencyClaimInput,
    response: IdempotencyResponse,
  ): Promise<void>;
}

export type AppendRunEventInput = {
  runId: string;
  type: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt?: Date;
};

export type RunEventRecord = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt: Date;
};

export interface RunEventRepository {
  append(input: AppendRunEventInput): Promise<RunEventRecord>;
}

export type TransactionRepositories = {
  idempotency: IdempotencyRepository;
  runEvents: RunEventRepository;
};

export interface Persistence {
  readonly reads: ReadRepository;
  transaction<T>(
    work: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
import type { ReadRepository } from "./read-model";
