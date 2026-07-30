import { sValidator } from "@hono/standard-validator";
import {
  createLearningCommandSchema,
  createMetricDefinitionCommandSchema,
  createProjectCommandSchema,
  createRunCommandSchema,
  decideExperimentCommandSchema,
  experimentIdParamSchema,
  experimentLifecycleCommandSchema,
  idempotencyHeaderSchema,
  projectIdParamSchema,
  proposeExperimentCommandSchema,
  recordBaselineCommandSchema,
  recordObservationCommandSchema,
  runIdParamSchema,
  runLifecycleCommandSchema,
} from "@socrates/contracts";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { CommandService } from "../../application/command-service";
import type { ExecutedCommand } from "../../application/idempotency";
import { apiError, validationHook } from "../../http/errors";

export type CommandRoutesOptions = {
  commands: CommandService | null;
  workspaceId: string;
};

function sendResult(
  context: Parameters<typeof apiError>[0],
  result: ExecutedCommand,
) {
  if (result.replayed) {
    context.header("Idempotency-Replayed", "true");
  }

  return context.json(
    result.body as Record<string, unknown>,
    result.status as ContentfulStatusCode,
  );
}

export function createCommandRoutes(options: CommandRoutesOptions) {
  const app = new Hono();
  const commands = options.commands;
  const unavailable = (context: Parameters<typeof apiError>[0]) =>
    apiError(
      context,
      503,
      "service_unavailable",
      "The persistence dependency is not configured.",
    );

  if (!commands) {
    app.post("/projects", unavailable);
    app.post("/projects/:projectId/metric-definitions", unavailable);
    app.post("/projects/:projectId/runs", unavailable);
    app.post("/runs/:runId/baseline", unavailable);
    app.post("/runs/:runId/start", unavailable);
    app.post("/runs/:runId/experiments", unavailable);
    app.post("/runs/:runId/complete", unavailable);
    app.post("/runs/:runId/cancel", unavailable);
    app.post("/experiments/:experimentId/start", unavailable);
    app.post("/experiments/:experimentId/observations", unavailable);
    app.post("/experiments/:experimentId/decision", unavailable);
    app.post("/experiments/:experimentId/learnings", unavailable);
    return app;
  }

  const contextFor = (idempotencyKey: string) => ({
    workspaceId: options.workspaceId,
    idempotencyKey,
  });

  app.post(
    "/projects",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("json", createProjectCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.createProject(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/projects/:projectId/metric-definitions",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", projectIdParamSchema, validationHook),
    sValidator("json", createMetricDefinitionCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.addMetricDefinition(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").projectId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/projects/:projectId/runs",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", projectIdParamSchema, validationHook),
    sValidator("json", createRunCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.createRun(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").projectId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/runs/:runId/baseline",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("json", recordBaselineCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.recordBaseline(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").runId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/runs/:runId/start",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("json", runLifecycleCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.startRun(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").runId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/runs/:runId/experiments",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("json", proposeExperimentCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.proposeExperiment(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").runId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/experiments/:experimentId/start",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", experimentIdParamSchema, validationHook),
    sValidator("json", experimentLifecycleCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.startExperiment(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").experimentId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/experiments/:experimentId/observations",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", experimentIdParamSchema, validationHook),
    sValidator("json", recordObservationCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.recordObservation(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").experimentId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/experiments/:experimentId/decision",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", experimentIdParamSchema, validationHook),
    sValidator("json", decideExperimentCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.decideExperiment(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").experimentId,
          context.req.valid("json"),
        ),
      ),
  );

  app.post(
    "/experiments/:experimentId/learnings",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", experimentIdParamSchema, validationHook),
    sValidator("json", createLearningCommandSchema, validationHook),
    async (context) =>
      sendResult(
        context,
        await commands.createLearning(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").experimentId,
          context.req.valid("json"),
        ),
      ),
  );

  const finishRun = (path: string, action: "complete" | "cancel") => {
    app.post(
      path,
      sValidator("header", idempotencyHeaderSchema, validationHook),
      sValidator("param", runIdParamSchema, validationHook),
      sValidator("json", runLifecycleCommandSchema, validationHook),
      async (context) => {
        const execute =
          action === "complete"
            ? commands.completeRun.bind(commands)
            : commands.cancelRun.bind(commands);

        return sendResult(
          context,
          await execute(
            contextFor(context.req.valid("header")["idempotency-key"]),
            context.req.valid("param").runId,
            context.req.valid("json"),
          ),
        );
      },
    );
  };

  finishRun("/runs/:runId/complete", "complete");
  finishRun("/runs/:runId/cancel", "cancel");

  return app;
}
