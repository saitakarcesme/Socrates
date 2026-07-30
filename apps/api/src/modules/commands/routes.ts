import { Hono } from "hono";

import type { ExperimentCommandService } from "../../application/commands/experiment-command-service";
import type { ProjectCommandService } from "../../application/commands/project-command-service";
import type { RunCommandService } from "../../application/commands/run-command-service";
import { createExperimentCommandRoutes } from "./experiment-routes";
import { createProjectCommandRoutes } from "./project-routes";
import { createRunCommandRoutes } from "./run-routes";

export type CommandRoutesOptions = {
  projectCommands: ProjectCommandService | null;
  runCommands: RunCommandService | null;
  experimentCommands: ExperimentCommandService | null;
  unavailableMessage: string;
  workspaceId: string;
};

export function createCommandRoutes(options: CommandRoutesOptions) {
  const app = new Hono();

  app.route(
    "/",
    createProjectCommandRoutes({
      commands: options.projectCommands,
      unavailableMessage: options.unavailableMessage,
      workspaceId: options.workspaceId,
    }),
  );
  app.route(
    "/",
    createRunCommandRoutes({
      commands: options.runCommands,
      unavailableMessage: options.unavailableMessage,
      workspaceId: options.workspaceId,
    }),
  );
  app.route(
    "/",
    createExperimentCommandRoutes({
      commands: options.experimentCommands,
      unavailableMessage: options.unavailableMessage,
      workspaceId: options.workspaceId,
    }),
  );

  return app;
}
