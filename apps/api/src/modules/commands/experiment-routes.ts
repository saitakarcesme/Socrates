import { sValidator } from "@hono/standard-validator";
import {
  createLearningCommandSchema,
  decideExperimentCommandSchema,
  experimentIdParamSchema,
  experimentLifecycleCommandSchema,
  idempotencyHeaderSchema,
  recordObservationCommandSchema,
} from "@socrates/contracts";
import { Hono } from "hono";

import type { ExperimentCommandService } from "../../application/commands/experiment-command-service";
import { validationHook } from "../../http/errors";
import {
  commandContext,
  type CommandRouteOptions,
  persistenceUnavailable,
  sendCommandResult,
} from "./shared";

type ExperimentCommands = Pick<
  ExperimentCommandService,
  | "startExperiment"
  | "recordObservation"
  | "decideExperiment"
  | "createLearning"
>;

export function createExperimentCommandRoutes(
  options: CommandRouteOptions<ExperimentCommands>,
) {
  const app = new Hono();
  const commands = options.commands;

  if (!commands) {
    app.post("/experiments/:experimentId/start", persistenceUnavailable);
    app.post("/experiments/:experimentId/observations", persistenceUnavailable);
    app.post("/experiments/:experimentId/decision", persistenceUnavailable);
    app.post("/experiments/:experimentId/learnings", persistenceUnavailable);
    return app;
  }

  const contextFor = (key: string) => commandContext(options.workspaceId, key);

  app.post(
    "/experiments/:experimentId/start",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", experimentIdParamSchema, validationHook),
    sValidator("json", experimentLifecycleCommandSchema, validationHook),
    async (context) =>
      sendCommandResult(
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
      sendCommandResult(
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
      sendCommandResult(
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
      sendCommandResult(
        context,
        await commands.createLearning(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").experimentId,
          context.req.valid("json"),
        ),
      ),
  );

  return app;
}
