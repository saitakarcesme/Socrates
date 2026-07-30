import type { ExecutedCommand } from "../../application/idempotency";
import { apiError } from "../../http/errors";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type CommandRouteOptions<T> = {
  commands: T | null;
  unavailableMessage: string;
  workspaceId: string;
};

export function commandContext(workspaceId: string, idempotencyKey: string) {
  return { workspaceId, idempotencyKey };
}

export function commandUnavailable(message: string) {
  return (context: Context) =>
    apiError(context, 503, "service_unavailable", message);
}

export function sendCommandResult(context: Context, result: ExecutedCommand) {
  if (result.replayed) {
    context.header("Idempotency-Replayed", "true");
  }

  return context.json(
    result.body as Record<string, unknown>,
    result.status as ContentfulStatusCode,
  );
}
