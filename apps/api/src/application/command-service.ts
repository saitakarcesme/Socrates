import { randomUUID } from "node:crypto";

import type {
  CreateLearningCommand,
  CreateMetricDefinitionCommand,
  CreateProjectCommand,
  CreateRunCommand,
  DecideExperimentCommand,
  ExperimentLifecycleCommand,
  RecordBaselineCommand,
  RecordObservationCommand,
  RunLifecycleCommand,
  ProposeExperimentCommand,
} from "@socrates/contracts";
import type {
  JsonValue,
  MetricDefinitionWrite,
  TransactionRepositories,
} from "@socrates/database";
import {
  assertExperimentTransition,
  assertMetricUnit,
  assertRunTransition,
  decideExperiment,
  evaluateBudget,
  evaluateConstraint,
} from "@socrates/domain";

import {
  invalidTransition,
  notFound,
  protocolMismatch,
  resourceConflict,
  versionConflict,
  CommandError,
} from "./errors";
import { type CommandResponse, IdempotentCommandExecutor } from "./idempotency";

const eventSchemaVersion = "1";
const decisionPolicyVersion = "manual-experiment-v1";

type CommandContext = {
  workspaceId: string;
  idempotencyKey: string;
};

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

function assertVersion(expected: number, actual: number): void {
  if (expected !== actual) {
    versionConflict(expected, actual);
  }
}

function metricWrite(
  projectId: string,
  version: number,
  metric: CreateProjectCommand["metric"],
): MetricDefinitionWrite {
  return {
    id: randomUUID(),
    projectId,
    version,
    name: metric.name,
    unit: metric.unit,
    direction: metric.direction,
    minimumImprovement: metric.minimumImprovement,
    noiseTolerance: metric.noiseTolerance,
    evaluatorConfig: {},
    guardrails: metric.guardrails.map((guardrail) => ({
      id: randomUUID(),
      ...guardrail,
    })),
  };
}

function response(status: number, body: JsonValue): CommandResponse {
  return { status, body };
}

function guardrailResources(metric: MetricDefinitionWrite) {
  return metric.guardrails.map((guardrail) => ({
    constraintDefinitionId: guardrail.id,
    name: guardrail.name,
    unit: guardrail.unit,
  }));
}

async function appendEvent(
  repositories: TransactionRepositories,
  runId: string,
  type: string,
  payload: JsonValue,
): Promise<void> {
  await repositories.runEvents.append({
    runId,
    type,
    schemaVersion: eventSchemaVersion,
    payload,
  });
}

export class CommandService {
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
        const metric = metricWrite(projectId, 1, command.metric);
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

        return response(201, {
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

        const metric = metricWrite(
          project.id,
          project.currentMetricVersion + 1,
          command.metric,
        );
        if (!(await commands.addMetricDefinition(metric, project.version))) {
          versionConflict(command.expectedProjectVersion, project.version);
        }

        return response(201, {
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
        await appendEvent(repositories, runId, "run.created", {
          runId,
          projectId,
          sequence: created.sequence,
        });

        return response(201, {
          data: { runId, projectId, version: 0, status: "draft" },
        });
      },
    );
  }

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
        if (!run) {
          notFound("run");
        }
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
        await appendEvent(repositories, runId, "run.baseline_recorded", {
          runId,
          observationId,
          metricDefinitionId: run.metricDefinitionId,
        });

        return response(200, {
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
        if (!run) {
          notFound("run");
        }
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
        await appendEvent(repositories, runId, "run.started", {
          runId,
          startedAt: startedAt.toISOString(),
        });

        return response(200, {
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
        if (!run) {
          notFound("run");
        }
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
        await appendEvent(repositories, runId, "experiment.proposed", {
          runId,
          experimentId,
          sequence: created.sequence,
        });

        return response(201, {
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
        if (!experiment) {
          notFound("experiment");
        }
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
        await appendEvent(
          repositories,
          experiment.runId,
          "experiment.started",
          {
            runId: experiment.runId,
            experimentId,
            startedAt: startedAt.toISOString(),
          },
        );

        return response(200, {
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
        if (!experiment) {
          notFound("experiment");
        }
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
        await appendEvent(
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

        return response(201, {
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
        if (!experiment) {
          notFound("experiment");
        }
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
        const finalDecision = command.override?.decision ?? automated.decision;
        const overrideReason =
          finalDecision === automated.decision
            ? null
            : (command.override?.reason ?? null);
        assertExperimentTransition("evaluating", finalDecision);

        await repositories.commands.recordDecision({
          id: randomUUID(),
          experimentId,
          policyVersion: decisionPolicyVersion,
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
        await appendEvent(
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

        return response(200, {
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
        if (!experiment) {
          notFound("experiment");
        }
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
        await appendEvent(
          repositories,
          experiment.runId,
          "experiment.learning_recorded",
          {
            runId: experiment.runId,
            experimentId,
            learningId,
          },
        );

        return response(201, {
          data: {
            learningId,
            experimentId,
            version: experiment.version + 1,
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
        if (!run) {
          notFound("run");
        }
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
        await appendEvent(repositories, runId, `run.${target}`, {
          runId,
          reason: command.reason ?? null,
          completedAt: completedAt.toISOString(),
        });

        return response(200, {
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
