import type { ReadRepository } from "@socrates/database";
import { Hono } from "hono";
import { requestId } from "hono/request-id";

import { InvalidCursorError } from "./http/cursor";
import { apiError } from "./http/errors";
import { createReadRoutes } from "./modules/reads/routes";

export const developmentWorkspaceId = "019c1170-8b7a-7a60-b7f8-f35c85d75000";

export type AppOptions = {
  reads?: ReadRepository;
  workspaceId?: string;
};

export function createApp(options: AppOptions = {}) {
  const app = new Hono();
  const reads = options.reads ?? null;

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

  app.onError((error, context) => {
    if (error instanceof InvalidCursorError) {
      return apiError(
        context,
        400,
        "validation_failed",
        "The supplied cursor is invalid.",
      );
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
