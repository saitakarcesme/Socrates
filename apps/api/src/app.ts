import type {
  JsonValue,
  Persistence,
  ReadRepository,
} from "@socrates/database";
import {
  ExperimentTransitionError,
  MetricProtocolError,
  RunTransitionError,
} from "@socrates/domain";
import type { RunnerAuthenticator } from "@socrates/runner-auth";
import { Hono } from "hono";
import { requestId } from "hono/request-id";

import { InvalidCursorError } from "./http/cursor";
import { apiError } from "./http/errors";
import { ExperimentCommandService } from "./application/commands/experiment-command-service";
import { ProjectCommandService } from "./application/commands/project-command-service";
import { RunCommandService } from "./application/commands/run-command-service";
import { CommandError } from "./application/errors";
import { IdempotentCommandExecutor } from "./application/idempotency";
import { createCommandRoutes } from "./modules/commands/routes";
import { createReadRoutes } from "./modules/reads/routes";
import { RunEventNotifier } from "./realtime/run-event-notifier";
import { RunnerGatewayService } from "./application/runner-gateway-service";
import { createRunnerRoutes } from "./modules/runner/routes";

export const developmentWorkspaceId = "019c1170-8b7a-7a60-b7f8-f35c85d75000";

export type AppOptions = {
  manualResearchEnabled?: boolean;
  persistence?: Persistence;
  reads?: ReadRepository;
  runnerAuthenticator?: RunnerAuthenticator;
  runnerOfferDurationMs?: number;
  workspaceId?: string;
};

function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono();
  const reads = options.persistence?.reads ?? options.reads ?? null;
  const runEventNotifier = options.persistence ? new RunEventNotifier() : null;
  const commandExecutor =
    options.persistence && options.manualResearchEnabled
      ? new IdempotentCommandExecutor(options.persistence, ({ response }) => {
          const body = response.body;
          if (!isJsonObject(body)) return;
          const data = body["data"];
          if (!data || !isJsonObject(data)) return;
          const runId = data["runId"];
          if (typeof runId === "string") runEventNotifier?.publish(runId);
        })
      : null;
  const projectCommands = commandExecutor
    ? new ProjectCommandService(commandExecutor)
    : null;
  const runCommands = commandExecutor
    ? new RunCommandService(commandExecutor)
    : null;
  const experimentCommands = commandExecutor
    ? new ExperimentCommandService(commandExecutor)
    : null;
  const runnerGateway =
    options.persistence && options.runnerAuthenticator
      ? new RunnerGatewayService(options.persistence, {
          offerDurationMs: options.runnerOfferDurationMs,
        })
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
        manualResearch: options.manualResearchEnabled ? "enabled" : "disabled",
        runnerGateway: runnerGateway ? "enabled" : "not_configured",
      },
    };

    return context.json(body, reads ? 200 : 503);
  });

  app.route(
    "/v1",
    createReadRoutes({
      reads,
      runEventNotifier,
      workspaceId: options.workspaceId ?? developmentWorkspaceId,
    }),
  );
  app.route(
    "/v1/runner",
    createRunnerRoutes({
      authenticator: options.runnerAuthenticator ?? null,
      gateway: runnerGateway,
    }),
  );
  app.route(
    "/v1",
    createCommandRoutes({
      projectCommands,
      runCommands,
      experimentCommands,
      unavailableMessage: !options.persistence
        ? "The persistence dependency is not configured."
        : "Manual research commands are disabled.",
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
