import { sValidator } from "@hono/standard-validator";
import {
  idempotencyHeaderSchema,
  proposeExperimentCommandSchema,
  recordBaselineCommandSchema,
  runIdParamSchema,
  runLifecycleCommandSchema,
} from "@socrates/contracts";
import { Hono } from "hono";

import type { RunCommandService } from "../../application/commands/run-command-service";
import { validationHook } from "../../http/errors";
import {
  commandContext,
  type CommandRouteOptions,
  commandUnavailable,
  sendCommandResult,
} from "./shared";

type RunCommands = Pick<
  RunCommandService,
  | "recordBaseline"
  | "startRun"
  | "proposeExperiment"
  | "completeRun"
  | "cancelRun"
>;

export function createRunCommandRoutes(
  options: CommandRouteOptions<RunCommands>,
) {
  const app = new Hono();
  const commands = options.commands;

  if (!commands) {
    const unavailable = commandUnavailable(options.unavailableMessage);
    app.post("/runs/:runId/baseline", unavailable);
    app.post("/runs/:runId/start", unavailable);
    app.post("/runs/:runId/experiments", unavailable);
    app.post("/runs/:runId/complete", unavailable);
    app.post("/runs/:runId/cancel", unavailable);
    return app;
  }

  const contextFor = (key: string) => commandContext(options.workspaceId, key);

  app.post(
    "/runs/:runId/baseline",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("json", recordBaselineCommandSchema, validationHook),
    async (context) =>
      sendCommandResult(
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
      sendCommandResult(
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
      sendCommandResult(
        context,
        await commands.proposeExperiment(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").runId,
          context.req.valid("json"),
        ),
      ),
  );

  const finish = (path: string, action: "complete" | "cancel") => {
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

        return sendCommandResult(
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

  finish("/runs/:runId/complete", "complete");
  finish("/runs/:runId/cancel", "cancel");

  return app;
}
