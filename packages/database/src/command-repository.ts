import { and, count, desc, eq, max, notInArray, sql, sum } from "drizzle-orm";

import type {
  CommandRepository,
  ConstraintDefinitionRecord,
  CreateProjectResult,
  CreateProjectWrite,
  DecisionEvidenceRecord,
  ExperimentCommandRecord,
  MetricDefinitionWrite,
  ProjectCommandRecord,
  RunCommandRecord,
  RunUsageRecord,
} from "./command-model";
import type { DatabaseTransaction } from "./database-types";
import type { JsonValue } from "./ports";
import * as schema from "./schema/index";

async function insertMetricDefinition(
  transaction: DatabaseTransaction,
  metric: MetricDefinitionWrite,
): Promise<void> {
  await transaction.insert(schema.metricDefinitions).values({
    id: metric.id,
    projectId: metric.projectId,
    version: metric.version,
    name: metric.name,
    unit: metric.unit,
    direction: metric.direction,
    minimumImprovement: metric.minimumImprovement,
    noiseTolerance: metric.noiseTolerance,
    evaluatorConfig: metric.evaluatorConfig ?? {},
  });

  if (metric.guardrails.length > 0) {
    await transaction.insert(schema.constraintDefinitions).values(
      metric.guardrails.map((guardrail) => ({
        id: guardrail.id,
        metricDefinitionId: metric.id,
        name: guardrail.name,
        unit: guardrail.unit,
        operator: guardrail.operator,
        threshold: guardrail.threshold,
        hard: guardrail.hard,
      })),
    );
  }
}

async function loadConstraints(
  transaction: DatabaseTransaction,
  metricDefinitionId: string,
): Promise<ConstraintDefinitionRecord[]> {
  return transaction
    .select({
      id: schema.constraintDefinitions.id,
      metricDefinitionId: schema.constraintDefinitions.metricDefinitionId,
      name: schema.constraintDefinitions.name,
      unit: schema.constraintDefinitions.unit,
      operator: schema.constraintDefinitions.operator,
      threshold: schema.constraintDefinitions.threshold,
      hard: schema.constraintDefinitions.hard,
    })
    .from(schema.constraintDefinitions)
    .where(
      eq(schema.constraintDefinitions.metricDefinitionId, metricDefinitionId),
    )
    .orderBy(schema.constraintDefinitions.id);
}

export class PostgresCommandRepository implements CommandRepository {
  constructor(private readonly transaction: DatabaseTransaction) {}

  async createProject(input: CreateProjectWrite): Promise<CreateProjectResult> {
    const [workspace] = await this.transaction
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .for("update");

    if (!workspace) {
      return { state: "workspace_not_found" };
    }

    const [slug] = await this.transaction
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.workspaceId, input.workspaceId),
          eq(schema.projects.slug, input.slug),
        ),
      )
      .limit(1);

    if (slug) {
      return { state: "slug_conflict" };
    }

    await this.transaction.insert(schema.projects).values({
      id: input.id,
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      objective: input.objective,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference,
    });
    await insertMetricDefinition(this.transaction, input.metric);

    return { state: "created" };
  }

  async lockProject(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectCommandRecord | null> {
    const [project] = await this.transaction
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        version: schema.projects.version,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          eq(schema.projects.id, projectId),
        ),
      )
      .for("update");

    if (!project) {
      return null;
    }

    const [metric] = await this.transaction
      .select({
        id: schema.metricDefinitions.id,
        version: schema.metricDefinitions.version,
      })
      .from(schema.metricDefinitions)
      .where(eq(schema.metricDefinitions.projectId, project.id))
      .orderBy(desc(schema.metricDefinitions.version))
      .limit(1);

    if (!metric) {
      throw new Error(`Project ${project.id} has no metric definition.`);
    }

    return {
      ...project,
      currentMetricVersion: metric.version,
      currentMetricDefinitionId: metric.id,
    };
  }

  async addMetricDefinition(
    metric: MetricDefinitionWrite,
    expectedProjectVersion: number,
  ): Promise<boolean> {
    await insertMetricDefinition(this.transaction, metric);

    const [updated] = await this.transaction
      .update(schema.projects)
      .set({
        version: sql`${schema.projects.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projects.id, metric.projectId),
          eq(schema.projects.version, expectedProjectVersion),
        ),
      )
      .returning({ id: schema.projects.id });

    return Boolean(updated);
  }

  async createRun(
    input: {
      id: string;
      projectId: string;
      metricDefinitionId: string;
      title: string;
      objective: string;
      budget: {
        maximumExperiments: number;
        maximumDurationMs: number;
        maximumCostMinor: number;
      };
    },
    expectedProjectVersion: number,
  ): Promise<{ sequence: number } | null> {
    const [cursor] = await this.transaction
      .select({ value: max(schema.runs.sequence) })
      .from(schema.runs)
      .where(eq(schema.runs.projectId, input.projectId));
    const sequence = (cursor?.value ?? 0) + 1;

    await this.transaction.insert(schema.runs).values({
      id: input.id,
      projectId: input.projectId,
      metricDefinitionId: input.metricDefinitionId,
      sequence,
      title: input.title,
      objective: input.objective,
    });
    await this.transaction.insert(schema.runBudgets).values({
      runId: input.id,
      ...input.budget,
    });

    const [updated] = await this.transaction
      .update(schema.projects)
      .set({
        version: sql`${schema.projects.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.projects.id, input.projectId),
          eq(schema.projects.version, expectedProjectVersion),
        ),
      )
      .returning({ id: schema.projects.id });

    return updated ? { sequence } : null;
  }

  async lockRun(
    workspaceId: string,
    runId: string,
  ): Promise<RunCommandRecord | null> {
    const [scope] = await this.transaction
      .select({ projectId: schema.runs.projectId })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          eq(schema.runs.id, runId),
        ),
      )
      .limit(1);

    if (!scope) {
      return null;
    }

    const project = await this.lockProject(workspaceId, scope.projectId);

    if (!project) {
      return null;
    }

    const [run] = await this.transaction
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        metricDefinitionId: schema.runs.metricDefinitionId,
        version: schema.runs.version,
        status: schema.runs.status,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .for("update");

    if (!run) {
      return null;
    }

    const [budget] = await this.transaction
      .select({
        maximumExperiments: schema.runBudgets.maximumExperiments,
        maximumDurationMs: schema.runBudgets.maximumDurationMs,
        maximumCostMinor: schema.runBudgets.maximumCostMinor,
      })
      .from(schema.runBudgets)
      .where(eq(schema.runBudgets.runId, run.id))
      .limit(1);
    const [metric] = await this.transaction
      .select({
        id: schema.metricDefinitions.id,
        projectId: schema.metricDefinitions.projectId,
        version: schema.metricDefinitions.version,
        name: schema.metricDefinitions.name,
        unit: schema.metricDefinitions.unit,
        direction: schema.metricDefinitions.direction,
        minimumImprovement: schema.metricDefinitions.minimumImprovement,
        noiseTolerance: schema.metricDefinitions.noiseTolerance,
        evaluatorConfig: schema.metricDefinitions.evaluatorConfig,
        createdAt: schema.metricDefinitions.createdAt,
      })
      .from(schema.metricDefinitions)
      .where(eq(schema.metricDefinitions.id, run.metricDefinitionId))
      .limit(1);
    const [baseline] = await this.transaction
      .select({
        amount: schema.observations.amount,
        unit: schema.observations.unit,
      })
      .from(schema.observations)
      .where(
        and(
          eq(schema.observations.runId, run.id),
          eq(schema.observations.kind, "baseline"),
        ),
      )
      .limit(1);

    if (!budget || !metric) {
      throw new Error(`Run ${run.id} has an incomplete persistence record.`);
    }
    const constraints = await loadConstraints(
      this.transaction,
      run.metricDefinitionId,
    );

    return {
      ...run,
      budget,
      baseline: baseline ?? null,
      metric: {
        ...metric,
        evaluatorConfig: metric.evaluatorConfig as JsonValue,
        guardrails: constraints,
      },
      constraints,
    };
  }

  async getRunUsage(runId: string): Promise<RunUsageRecord> {
    const [usage] = await this.transaction
      .select({
        experiments: count(),
        durationMs: sum(schema.experiments.estimatedDurationMs),
        costMinor: sum(schema.experiments.estimatedCostMinor),
      })
      .from(schema.experiments)
      .where(eq(schema.experiments.runId, runId));

    return {
      experiments: usage?.experiments ?? 0,
      durationMs: Number(usage?.durationMs ?? 0),
      costMinor: Number(usage?.costMinor ?? 0),
    };
  }

  async countOpenExperiments(runId: string): Promise<number> {
    const [result] = await this.transaction
      .select({ value: count() })
      .from(schema.experiments)
      .where(
        and(
          eq(schema.experiments.runId, runId),
          notInArray(schema.experiments.status, [
            "failed",
            "kept",
            "discarded",
            "inconclusive",
          ]),
        ),
      );

    return result?.value ?? 0;
  }

  async recordBaseline(
    input: Parameters<CommandRepository["recordBaseline"]>[0],
  ): Promise<void> {
    await this.transaction.insert(schema.observations).values({
      ...input,
      kind: "baseline",
    });
  }

  async updateRun(
    input: Parameters<CommandRepository["updateRun"]>[0],
  ): Promise<boolean> {
    const [updated] = await this.transaction
      .update(schema.runs)
      .set({
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        version: sql`${schema.runs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.runs.id, input.runId),
          eq(schema.runs.version, input.expectedVersion),
        ),
      )
      .returning({ id: schema.runs.id });

    return Boolean(updated);
  }

  async parentExperimentExists(
    runId: string,
    experimentId: string,
  ): Promise<boolean> {
    const [parent] = await this.transaction
      .select({ id: schema.experiments.id })
      .from(schema.experiments)
      .where(
        and(
          eq(schema.experiments.runId, runId),
          eq(schema.experiments.id, experimentId),
        ),
      )
      .limit(1);

    return Boolean(parent);
  }

  async createExperiment(
    input: Parameters<CommandRepository["createExperiment"]>[0],
    expectedRunVersion: number,
  ): Promise<{ sequence: number } | null> {
    const [cursor] = await this.transaction
      .select({ value: max(schema.experiments.sequence) })
      .from(schema.experiments)
      .where(eq(schema.experiments.runId, input.runId));
    const sequence = (cursor?.value ?? 0) + 1;

    await this.transaction.insert(schema.experiments).values({
      ...input,
      sequence,
    });

    const [updated] = await this.transaction
      .update(schema.runs)
      .set({
        version: sql`${schema.runs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.runs.id, input.runId),
          eq(schema.runs.version, expectedRunVersion),
        ),
      )
      .returning({ id: schema.runs.id });

    return updated ? { sequence } : null;
  }

  async lockExperiment(
    workspaceId: string,
    experimentId: string,
  ): Promise<ExperimentCommandRecord | null> {
    const [scope] = await this.transaction
      .select({ runId: schema.experiments.runId })
      .from(schema.experiments)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.experiments.runId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          eq(schema.experiments.id, experimentId),
        ),
      )
      .limit(1);

    if (!scope) {
      return null;
    }

    const run = await this.lockRun(workspaceId, scope.runId);

    if (!run) {
      return null;
    }

    const [experiment] = await this.transaction
      .select({
        id: schema.experiments.id,
        runId: schema.experiments.runId,
        version: schema.experiments.version,
        status: schema.experiments.status,
      })
      .from(schema.experiments)
      .where(eq(schema.experiments.id, experimentId))
      .for("update");

    return experiment
      ? {
          ...experiment,
          projectId: run.projectId,
          run,
        }
      : null;
  }

  async updateExperiment(
    input: Parameters<CommandRepository["updateExperiment"]>[0],
  ): Promise<boolean> {
    const [updated] = await this.transaction
      .update(schema.experiments)
      .set({
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        version: sql`${schema.experiments.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.experiments.id, input.experimentId),
          eq(schema.experiments.version, input.expectedVersion),
        ),
      )
      .returning({ id: schema.experiments.id });

    return Boolean(updated);
  }

  async recordObservation(
    input: Parameters<CommandRepository["recordObservation"]>[0],
  ): Promise<void> {
    await this.transaction.insert(schema.observations).values(input);
  }

  async loadDecisionEvidence(
    experiment: ExperimentCommandRecord,
  ): Promise<DecisionEvidenceRecord> {
    const observations = await this.transaction
      .select({
        kind: schema.observations.kind,
        metricDefinitionId: schema.observations.metricDefinitionId,
        constraintDefinitionId: schema.observations.constraintDefinitionId,
        amount: schema.observations.amount,
        unit: schema.observations.unit,
      })
      .from(schema.observations)
      .where(eq(schema.observations.experimentId, experiment.id));

    const primary = (kind: "before" | "after") => {
      const observation = observations.find(
        (candidate) =>
          candidate.kind === kind &&
          candidate.metricDefinitionId === experiment.run.metricDefinitionId,
      );

      return observation
        ? { amount: observation.amount, unit: observation.unit }
        : null;
    };

    return {
      before: primary("before"),
      after: primary("after"),
      guardrails: experiment.run.constraints.map((constraint) => {
        const observation = observations.find(
          (candidate) =>
            candidate.kind === "guardrail" &&
            candidate.constraintDefinitionId === constraint.id,
        );

        return {
          constraint,
          observation: observation
            ? { amount: observation.amount, unit: observation.unit }
            : null,
        };
      }),
    };
  }

  async recordDecision(
    input: Parameters<CommandRepository["recordDecision"]>[0],
  ): Promise<void> {
    await this.transaction.insert(schema.decisions).values(input);
  }

  async recordLearning(
    input: Parameters<CommandRepository["recordLearning"]>[0],
  ): Promise<void> {
    await this.transaction.insert(schema.learnings).values({
      id: input.id,
      projectId: input.projectId,
      statement: input.statement,
      confidence: input.confidence,
    });
    await this.transaction.insert(schema.learningEvidence).values({
      learningId: input.id,
      experimentId: input.experimentId,
      role: input.evidenceRole,
    });
  }
}
