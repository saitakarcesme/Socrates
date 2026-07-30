import type { ApiErrorCode } from "@socrates/contracts";

export type CommandErrorStatus = 404 | 409 | 422;

export class CommandError extends Error {
  constructor(
    readonly status: CommandErrorStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function notFound(resource: string): never {
  throw new CommandError(
    404,
    "not_found",
    `The requested ${resource} does not exist.`,
  );
}

export function versionConflict(expected: number, actual: number): never {
  throw new CommandError(
    409,
    "version_conflict",
    "The resource changed after it was read.",
    { expectedVersion: expected, actualVersion: actual },
  );
}

export function resourceConflict(message: string): never {
  throw new CommandError(409, "resource_conflict", message);
}

export function invalidTransition(message: string): never {
  throw new CommandError(409, "invalid_transition", message);
}

export function protocolMismatch(message: string): never {
  throw new CommandError(422, "protocol_mismatch", message);
}
