import { randomUUID } from "node:crypto";

import type {
  CreateMetricDefinitionCommand,
  CreateProjectCommand,
  CreateRunCommand,
} from "@socrates/contracts";

import {
  notFound,
  protocolMismatch,
  resourceConflict,
  versionConflict,
} from "../errors";
import { IdempotentCommandExecutor } from "../idempotency";
import {
  appendRunEvent,
  assertVersion,
  type CommandContext,
  commandResponse,
  createMetricWrite,
  guardrailResources,
} from "./shared";

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/g, "");

  return slug || "project";
}

export class ProjectCommandService {
  constructor(private readonly executor: IdempotentCommandExecutor) {}

  createProject(context: CommandContext, command: CreateProjectCommand) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "project.create",
        body: command,
      },
      async ({ commands }) => {
        const projectId = randomUUID();
        const metric = createMetricWrite(projectId, 1, command.metric);
        const result = await commands.createProject({
          id: projectId,
          workspaceId: context.workspaceId,
          name: command.name,
          slug: slugify(command.name),
          objective: command.objective,
          sourceType: command.source?.type ?? null,
          sourceReference: command.source?.reference ?? null,
          metric,
        });

        if (result.state === "workspace_not_found") {
          notFound("workspace");
        }
        if (result.state === "slug_conflict") {
          resourceConflict("A project with this slug already exists.");
        }

        return commandResponse(201, {
          data: {
            projectId,
            projectVersion: 0,
            currentMetricDefinitionId: metric.id,
            guardrails: guardrailResources(metric),
          },
        });
      },
    );
  }

  addMetricDefinition(
    context: CommandContext,
    projectId: string,
    command: CreateMetricDefinitionCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "project.metric.create",
        body: { projectId, ...command },
      },
      async ({ commands }) => {
        const project = await commands.lockProject(
          context.workspaceId,
          projectId,
        );
        if (!project) {
          notFound("project");
        }
        assertVersion(command.expectedProjectVersion, project.version);

        const metric = createMetricWrite(
          project.id,
          project.currentMetricVersion + 1,
          command.metric,
        );
        if (!(await commands.addMetricDefinition(metric, project.version))) {
          versionConflict(command.expectedProjectVersion, project.version);
        }

        return commandResponse(201, {
          data: {
            projectId,
            projectVersion: project.version + 1,
            currentMetricDefinitionId: metric.id,
            guardrails: guardrailResources(metric),
          },
        });
      },
    );
  }

  createRun(
    context: CommandContext,
    projectId: string,
    command: CreateRunCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "run.create",
        body: { projectId, ...command },
      },
      async (repositories) => {
        const project = await repositories.commands.lockProject(
          context.workspaceId,
          projectId,
        );
        if (!project) {
          notFound("project");
        }
        assertVersion(command.expectedProjectVersion, project.version);
        if (command.metricDefinitionId !== project.currentMetricDefinitionId) {
          protocolMismatch(
            "New runs must use the project's current metric definition.",
          );
        }

        const runId = randomUUID();
        const created = await repositories.commands.createRun(
          {
            id: runId,
            projectId,
            metricDefinitionId: command.metricDefinitionId,
            title: command.title,
            objective: command.objective,
            budget: command.budget,
          },
          project.version,
        );
        if (!created) {
          versionConflict(command.expectedProjectVersion, project.version);
        }
        await appendRunEvent(repositories, runId, "run.created", {
          runId,
          projectId,
          sequence: created.sequence,
        });

        return commandResponse(201, {
          data: { runId, projectId, version: 0, status: "draft" },
        });
      },
    );
  }
}
