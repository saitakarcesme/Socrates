import type { Persistence, ReadRepository } from "@socrates/database";
import {
  ExperimentTransitionError,
  MetricProtocolError,
  RunTransitionError,
} from "@socrates/domain";
import { Hono } from "hono";
import { requestId } from "hono/request-id";

import { InvalidCursorError } from "./http/cursor";
import { apiError } from "./http/errors";
import { CommandService } from "./application/command-service";
import { CommandError } from "./application/errors";
import { IdempotentCommandExecutor } from "./application/idempotency";
import { createCommandRoutes } from "./modules/commands/routes";
import { createReadRoutes } from "./modules/reads/routes";

export const developmentWorkspaceId = "019c1170-8b7a-7a60-b7f8-f35c85d75000";

export type AppOptions = {
  persistence?: Persistence;
  reads?: ReadRepository;
  workspaceId?: string;
};

export function createApp(options: AppOptions = {}) {
  const app = new Hono();
  const reads = options.persistence?.reads ?? options.reads ?? null;
  const commands = options.persistence
    ? new CommandService(new IdempotentCommandExecutor(options.persistence))
    : null;

  app.use("*", requestId());

  app.get("/v1/health", (context) =>
    context.json({
      status: "ok",
      service: "socrates-api",
      version: "0.0.0",
    }),
  );

  app.get("/v1/ready", (context) => {
    const body = {
      status: reads ? "ready" : "not_ready",
      checks: {
        api: "ok",
        database: reads ? "ok" : "not_configured",
        runnerGateway: "not_configured",
      },
    };

    return context.json(body, reads ? 200 : 503);
  });

  app.route(
    "/v1",
    createReadRoutes({
      reads,
      workspaceId: options.workspaceId ?? developmentWorkspaceId,
    }),
  );
  app.route(
    "/v1",
    createCommandRoutes({
      commands,
      workspaceId: options.workspaceId ?? developmentWorkspaceId,
    }),
  );

  app.onError((error, context) => {
    if (error instanceof InvalidCursorError) {
      return apiError(
        context,
        400,
        "validation_failed",
        "The supplied cursor is invalid.",
      );
    }

    if (error instanceof CommandError) {
      return apiError(
        context,
        error.status,
        error.code,
        error.message,
        error.details,
      );
    }

    if (
      error instanceof RunTransitionError ||
      error instanceof ExperimentTransitionError
    ) {
      return apiError(context, 409, "invalid_transition", error.message);
    }

    if (error instanceof MetricProtocolError) {
      return apiError(context, 422, "protocol_mismatch", error.message, {
        protocolCode: error.code,
      });
    }

    console.error(error);

    return apiError(
      context,
      500,
      "internal_error",
      "The request could not be completed.",
    );
  });

  app.notFound((context) =>
    apiError(
      context,
      404,
      "not_found",
      "The requested resource does not exist.",
    ),
  );

  return app;
}
