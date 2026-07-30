import { randomUUID } from "node:crypto";

import type {
  ProposeExperimentCommand,
  RecordBaselineCommand,
  RunLifecycleCommand,
} from "@socrates/contracts";
import type { TransactionRepositories } from "@socrates/database";
import {
  assertMetricUnit,
  assertRunTransition,
  evaluateBudget,
} from "@socrates/domain";

import {
  CommandError,
  invalidTransition,
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
} from "./shared";

export class RunCommandService {
  constructor(private readonly executor: IdempotentCommandExecutor) {}

  recordBaseline(
    context: CommandContext,
    runId: string,
    command: RecordBaselineCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "run.baseline.record",
        body: { runId, ...command },
      },
      async (repositories) => {
        const run = await repositories.commands.lockRun(
          context.workspaceId,
          runId,
        );
        if (!run) notFound("run");
        assertVersion(command.expectedVersion, run.version);
        if (run.status !== "draft") {
          invalidTransition("A baseline can only be recorded for a draft run.");
        }
        if (run.baseline) {
          resourceConflict("The run already has a baseline observation.");
        }
        assertMetricUnit(run.metric.unit, command.value);

        const observationId = randomUUID();
        await repositories.commands.recordBaseline({
          id: observationId,
          runId,
          metricDefinitionId: run.metricDefinitionId,
          amount: command.value.amount,
          unit: command.value.unit,
          sampleCount: command.sampleCount,
          notes: command.notes,
        });
        await this.updateRun(repositories, runId, run.version);
        await appendRunEvent(repositories, runId, "run.baseline_recorded", {
          runId,
          observationId,
          metricDefinitionId: run.metricDefinitionId,
        });

        return commandResponse(200, {
          data: {
            runId,
            projectId: run.projectId,
            version: run.version + 1,
            status: run.status,
          },
        });
      },
    );
  }

  startRun(
    context: CommandContext,
    runId: string,
    command: RunLifecycleCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "run.start",
        body: { runId, ...command },
      },
      async (repositories) => {
        const run = await repositories.commands.lockRun(
          context.workspaceId,
          runId,
        );
        if (!run) notFound("run");
        assertVersion(command.expectedVersion, run.version);
        if (!run.baseline) {
          invalidTransition("A baseline is required before a run can start.");
        }
        assertRunTransition(run.status, "queued");
        assertRunTransition("queued", "preparing");
        assertRunTransition("preparing", "running");

        const startedAt = new Date();
        await this.updateRun(
          repositories,
          runId,
          run.version,
          "running",
          startedAt,
        );
        await appendRunEvent(repositories, runId, "run.started", {
          runId,
          startedAt: startedAt.toISOString(),
        });

        return commandResponse(200, {
          data: {
            runId,
            projectId: run.projectId,
            version: run.version + 1,
            status: "running",
          },
        });
      },
    );
  }

  proposeExperiment(
    context: CommandContext,
    runId: string,
    command: ProposeExperimentCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "experiment.propose",
        body: { runId, ...command },
      },
      async (repositories) => {
        const run = await repositories.commands.lockRun(
          context.workspaceId,
          runId,
        );
        if (!run) notFound("run");
        assertVersion(command.expectedRunVersion, run.version);
        if (run.status !== "running") {
          invalidTransition(
            "Experiments can only be proposed for a running run.",
          );
        }
        if (
          command.parentExperimentId &&
          !(await repositories.commands.parentExperimentExists(
            runId,
            command.parentExperimentId,
          ))
        ) {
          protocolMismatch(
            "The parent experiment must belong to the same run.",
          );
        }

        const budget = evaluateBudget(
          run.budget,
          await repositories.commands.getRunUsage(runId),
          {
            experiments: 1,
            durationMs: command.estimatedDurationMs,
            costMinor: command.estimatedCostMinor,
          },
        );
        if (!budget.allowed) {
          throw new CommandError(
            409,
            "budget_exhausted",
            "The experiment would exceed the run budget.",
            { exhausted: budget.exhausted },
          );
        }

        const experimentId = randomUUID();
        const created = await repositories.commands.createExperiment(
          {
            id: experimentId,
            runId,
            parentExperimentId: command.parentExperimentId ?? null,
            hypothesis: command.hypothesis,
            action: command.action,
            estimatedDurationMs: command.estimatedDurationMs,
            estimatedCostMinor: command.estimatedCostMinor,
          },
          run.version,
        );
        if (!created) {
          versionConflict(command.expectedRunVersion, run.version);
        }
        await appendRunEvent(repositories, runId, "experiment.proposed", {
          runId,
          experimentId,
          sequence: created.sequence,
        });

        return commandResponse(201, {
          data: {
            experimentId,
            runId,
            version: 0,
            status: "proposed",
          },
        });
      },
    );
  }

  completeRun(
    context: CommandContext,
    runId: string,
    command: RunLifecycleCommand,
  ) {
    return this.finishRun(context, runId, command, "completed");
  }

  cancelRun(
    context: CommandContext,
    runId: string,
    command: RunLifecycleCommand,
  ) {
    return this.finishRun(context, runId, command, "cancelled");
  }

  private finishRun(
    context: CommandContext,
    runId: string,
    command: RunLifecycleCommand,
    target: "completed" | "cancelled",
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: `run.${target}`,
        body: { runId, ...command },
      },
      async (repositories) => {
        const run = await repositories.commands.lockRun(
          context.workspaceId,
          runId,
        );
        if (!run) notFound("run");
        assertVersion(command.expectedVersion, run.version);

        if (target === "completed") {
          assertRunTransition(run.status, "completed");
          if ((await repositories.commands.countOpenExperiments(runId)) > 0) {
            invalidTransition(
              "A run cannot complete while experiments are still open.",
            );
          }
        } else {
          assertRunTransition(run.status, "cancelling");
          assertRunTransition("cancelling", "cancelled");
        }

        const completedAt = new Date();
        await this.updateRun(
          repositories,
          runId,
          run.version,
          target,
          undefined,
          completedAt,
        );
        await appendRunEvent(repositories, runId, `run.${target}`, {
          runId,
          reason: command.reason ?? null,
          completedAt: completedAt.toISOString(),
        });

        return commandResponse(200, {
          data: {
            runId,
            projectId: run.projectId,
            version: run.version + 1,
            status: target,
          },
        });
      },
    );
  }

  private async updateRun(
    repositories: TransactionRepositories,
    runId: string,
    expectedVersion: number,
    status?: Parameters<
      TransactionRepositories["commands"]["updateRun"]
    >[0]["status"],
    startedAt?: Date,
    completedAt?: Date,
  ): Promise<void> {
    if (
      !(await repositories.commands.updateRun({
        runId,
        expectedVersion,
        status,
        startedAt,
        completedAt,
      }))
    ) {
      versionConflict(expectedVersion, expectedVersion + 1);
    }
  }
}
