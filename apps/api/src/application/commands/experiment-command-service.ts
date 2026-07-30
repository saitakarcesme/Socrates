import { randomUUID } from "node:crypto";

import type {
  CreateLearningCommand,
  DecideExperimentCommand,
  ExperimentLifecycleCommand,
  RecordObservationCommand,
} from "@socrates/contracts";
import type { TransactionRepositories } from "@socrates/database";
import {
  applyDecisionOverride,
  assertExperimentTransition,
  assertMetricUnit,
  DecisionOverrideError,
  decideExperiment,
  evaluateConstraint,
} from "@socrates/domain";

import {
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

export class ExperimentCommandService {
  constructor(private readonly executor: IdempotentCommandExecutor) {}

  startExperiment(
    context: CommandContext,
    experimentId: string,
    command: ExperimentLifecycleCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "experiment.start",
        body: { experimentId, ...command },
      },
      async (repositories) => {
        const experiment = await repositories.commands.lockExperiment(
          context.workspaceId,
          experimentId,
        );
        if (!experiment) notFound("experiment");
        assertVersion(command.expectedVersion, experiment.version);
        if (experiment.run.status !== "running") {
          invalidTransition(
            "An experiment can only start while its run is running.",
          );
        }
        assertExperimentTransition(experiment.status, "queued");
        assertExperimentTransition("queued", "executing");

        const startedAt = new Date();
        await this.updateExperiment(
          repositories,
          experimentId,
          experiment.version,
          "executing",
          startedAt,
        );
        await appendRunEvent(
          repositories,
          experiment.runId,
          "experiment.started",
          {
            runId: experiment.runId,
            experimentId,
            startedAt: startedAt.toISOString(),
          },
        );

        return commandResponse(200, {
          data: {
            experimentId,
            runId: experiment.runId,
            version: experiment.version + 1,
            status: "executing",
          },
        });
      },
    );
  }

  recordObservation(
    context: CommandContext,
    experimentId: string,
    command: RecordObservationCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "experiment.observation.record",
        body: { experimentId, ...command },
      },
      async (repositories) => {
        const experiment = await repositories.commands.lockExperiment(
          context.workspaceId,
          experimentId,
        );
        if (!experiment) notFound("experiment");
        assertVersion(command.expectedVersion, experiment.version);
        if (!["executing", "measuring"].includes(experiment.status)) {
          invalidTransition(
            "Observations can only be recorded while an experiment is executing or measuring.",
          );
        }

        const evidence =
          await repositories.commands.loadDecisionEvidence(experiment);
        let metricDefinitionId: string | null = null;
        let constraintDefinitionId: string | null = null;

        if (command.kind === "guardrail") {
          const constraint = experiment.run.constraints.find(
            (candidate) => candidate.id === command.constraintDefinitionId,
          );
          if (!constraint) {
            protocolMismatch(
              "The guardrail does not belong to the run's metric definition.",
            );
          }
          if (
            evidence.guardrails.find(
              (item) => item.constraint.id === constraint.id,
            )?.observation
          ) {
            resourceConflict(
              "This guardrail already has an observation for the experiment.",
            );
          }
          assertMetricUnit(constraint.unit, command.value);
          constraintDefinitionId = constraint.id;
        } else {
          if (
            command.metricDefinitionId !== experiment.run.metricDefinitionId
          ) {
            protocolMismatch(
              "The observation must use the run's frozen metric definition.",
            );
          }
          if (evidence[command.kind]) {
            resourceConflict(
              `The experiment already has a ${command.kind} observation.`,
            );
          }
          if (command.kind === "before" && experiment.status !== "executing") {
            invalidTransition(
              "A before observation must be recorded while executing.",
            );
          }
          assertMetricUnit(experiment.run.metric.unit, command.value);
          metricDefinitionId = command.metricDefinitionId;
        }

        const nextStatus =
          command.kind === "after" ? "measuring" : experiment.status;
        if (command.kind === "after" && experiment.status === "executing") {
          assertExperimentTransition("executing", "measuring");
        }

        const observationId = randomUUID();
        await repositories.commands.recordObservation({
          id: observationId,
          runId: experiment.runId,
          experimentId,
          kind: command.kind,
          metricDefinitionId,
          constraintDefinitionId,
          amount: command.value.amount,
          unit: command.value.unit,
          sampleCount: command.sampleCount,
          notes: command.notes,
        });
        await this.updateExperiment(
          repositories,
          experimentId,
          experiment.version,
          nextStatus,
        );
        await appendRunEvent(
          repositories,
          experiment.runId,
          "experiment.observation_recorded",
          {
            runId: experiment.runId,
            experimentId,
            observationId,
            kind: command.kind,
          },
        );

        return commandResponse(201, {
          data: {
            observationId,
            experimentId,
            version: experiment.version + 1,
            status: nextStatus,
          },
        });
      },
    );
  }

  decideExperiment(
    context: CommandContext,
    experimentId: string,
    command: DecideExperimentCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "experiment.decide",
        body: { experimentId, ...command },
      },
      async (repositories) => {
        const experiment = await repositories.commands.lockExperiment(
          context.workspaceId,
          experimentId,
        );
        if (!experiment) notFound("experiment");
        assertVersion(command.expectedVersion, experiment.version);
        assertExperimentTransition(experiment.status, "evaluating");

        const evidence =
          await repositories.commands.loadDecisionEvidence(experiment);
        const hardGuardrails = evidence.guardrails.filter(
          ({ constraint }) => constraint.hard,
        );
        const measurementValid =
          Boolean(evidence.before && evidence.after) &&
          hardGuardrails.every(({ observation }) => Boolean(observation));
        const guardrailsPassed = hardGuardrails.every(
          ({ constraint, observation }) =>
            Boolean(
              observation &&
              evaluateConstraint({
                operator: constraint.operator,
                threshold: {
                  amount: constraint.threshold,
                  unit: constraint.unit,
                },
                observed: observation,
              }),
            ),
        );
        const automated = decideExperiment({
          protocol: {
            direction: experiment.run.metric.direction,
            unit: experiment.run.metric.unit,
            minimumImprovement: experiment.run.metric.minimumImprovement,
            noiseTolerance: experiment.run.metric.noiseTolerance,
          },
          before: evidence.before,
          after: evidence.after,
          guardrailsPassed,
          measurementValid,
        });
        let appliedDecision;
        try {
          appliedDecision = applyDecisionOverride(automated, command.override);
        } catch (error) {
          if (error instanceof DecisionOverrideError) {
            invalidTransition(error.message);
          }
          throw error;
        }
        const { finalDecision, overrideReason } = appliedDecision;
        assertExperimentTransition("evaluating", finalDecision);

        await repositories.commands.recordDecision({
          id: randomUUID(),
          experimentId,
          policyVersion: "manual-experiment-v1",
          automatedDecision: automated.decision,
          reason: automated.reason,
          finalDecision,
          overrideReason,
          calculatedImprovement: automated.improvement,
        });
        const completedAt = new Date();
        await this.updateExperiment(
          repositories,
          experimentId,
          experiment.version,
          finalDecision,
          undefined,
          completedAt,
        );
        await appendRunEvent(
          repositories,
          experiment.runId,
          "experiment.decided",
          {
            runId: experiment.runId,
            experimentId,
            automatedDecision: automated.decision,
            finalDecision,
            reason: automated.reason,
            improvement: automated.improvement,
          },
        );

        return commandResponse(200, {
          data: {
            experimentId,
            runId: experiment.runId,
            version: experiment.version + 1,
            status: finalDecision,
          },
        });
      },
    );
  }

  createLearning(
    context: CommandContext,
    experimentId: string,
    command: CreateLearningCommand,
  ) {
    return this.executor.execute(
      {
        ...context,
        key: context.idempotencyKey,
        commandName: "experiment.learning.create",
        body: { experimentId, ...command },
      },
      async (repositories) => {
        const experiment = await repositories.commands.lockExperiment(
          context.workspaceId,
          experimentId,
        );
        if (!experiment) notFound("experiment");
        assertVersion(command.expectedVersion, experiment.version);
        if (
          !["kept", "discarded", "inconclusive"].includes(experiment.status)
        ) {
          invalidTransition(
            "Learnings can only be recorded for a decided experiment.",
          );
        }

        const learningId = randomUUID();
        await repositories.commands.recordLearning({
          id: learningId,
          projectId: experiment.projectId,
          experimentId,
          statement: command.statement,
          confidence: command.confidence,
          evidenceRole: command.evidenceRole,
        });
        await this.updateExperiment(
          repositories,
          experimentId,
          experiment.version,
        );
        await appendRunEvent(
          repositories,
          experiment.runId,
          "experiment.learning_recorded",
          {
            runId: experiment.runId,
            experimentId,
            learningId,
          },
        );

        return commandResponse(201, {
          data: {
            learningId,
            experimentId,
            version: experiment.version + 1,
          },
        });
      },
    );
  }

  private async updateExperiment(
    repositories: TransactionRepositories,
    experimentId: string,
    expectedVersion: number,
    status?: Parameters<
      TransactionRepositories["commands"]["updateExperiment"]
    >[0]["status"],
    startedAt?: Date,
    completedAt?: Date,
  ): Promise<void> {
    if (
      !(await repositories.commands.updateExperiment({
        experimentId,
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
