import { Hono } from "hono";
import { requestId } from "hono/request-id";

export function createApp() {
  const app = new Hono();

  app.use("*", requestId());

  app.get("/v1/health", (context) =>
    context.json({
      status: "ok",
      service: "socrates-api",
      version: "0.0.0",
    }),
  );

  app.get("/v1/ready", (context) =>
    context.json({
      status: "ready",
      checks: {
        api: "ok",
        database: "not_configured",
        runnerGateway: "not_configured",
      },
    }),
  );

  app.notFound((context) =>
    context.json(
      {
        error: {
          code: "not_found",
          message: "The requested resource does not exist.",
          requestId: context.get("requestId"),
        },
      },
      404,
    ),
  );

  return app;
}
