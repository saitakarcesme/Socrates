import { sValidator } from "@hono/standard-validator";
import {
  createMetricDefinitionCommandSchema,
  createProjectCommandSchema,
  createRunCommandSchema,
  idempotencyHeaderSchema,
  projectIdParamSchema,
} from "@socrates/contracts";
import { Hono } from "hono";

import type { ProjectCommandService } from "../../application/commands/project-command-service";
import { validationHook } from "../../http/errors";
import {
  commandContext,
  type CommandRouteOptions,
  persistenceUnavailable,
  sendCommandResult,
} from "./shared";

type ProjectCommands = Pick<
  ProjectCommandService,
  "createProject" | "addMetricDefinition" | "createRun"
>;

export function createProjectCommandRoutes(
  options: CommandRouteOptions<ProjectCommands>,
) {
  const app = new Hono();
  const commands = options.commands;

  if (!commands) {
    app.post("/projects", persistenceUnavailable);
    app.post("/projects/:projectId/metric-definitions", persistenceUnavailable);
    app.post("/projects/:projectId/runs", persistenceUnavailable);
    return app;
  }

  const contextFor = (key: string) => commandContext(options.workspaceId, key);

  app.post(
    "/projects",
    sValidator("header", idempotencyHeaderSchema, validationHook),
    sValidator("json", createProjectCommandSchema, validationHook),
    async (context) =>
      sendCommandResult(
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
      sendCommandResult(
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
      sendCommandResult(
        context,
        await commands.createRun(
          contextFor(context.req.valid("header")["idempotency-key"]),
          context.req.valid("param").projectId,
          context.req.valid("json"),
        ),
      ),
  );

  return app;
}
