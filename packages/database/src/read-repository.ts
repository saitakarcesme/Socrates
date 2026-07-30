import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  CreatedCursor,
  EventReadPage,
  ExperimentRead,
  LearningRead,
  MetricDefinitionRead,
  ProjectRead,
  ReadPage,
  ReadRepository,
  RunDetailRead,
  RunEventRead,
  RunRead,
} from "./read-model";
import type { JsonValue } from "./ports";
import * as schema from "./schema/index";

type Database = PostgresJsDatabase<typeof schema>;

function createdBefore(
  createdAt: unknown,
  id: unknown,
  cursor: CreatedCursor | null,
): SQL | undefined {
  if (!cursor) {
    return undefined;
  }

  const cursorTimestamp = cursor.createdAt.toISOString();

  return sql`(${createdAt} < ${cursorTimestamp}::timestamptz OR (${createdAt} = ${cursorTimestamp}::timestamptz AND ${id} < ${cursor.id}))`;
}

function pageFromRows<T extends { createdAt: Date; id: string }>(
  rows: readonly T[],
  limit: number,
): ReadPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last
        ? {
            createdAt: last.createdAt,
            id: last.id,
          }
        : null,
  };
}

function eventPageFromRows(
  rows: readonly RunEventRead[],
  limit: number,
): EventReadPage<RunEventRead> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.sequence ?? null) : null,
  };
}

function mapProject(
  row: Omit<ProjectRead, "currentMetric"> & {
    metricId: string;
    metricProjectId: string;
    metricVersion: number;
    metricName: string;
    metricUnit: string;
    metricDirection: "maximize" | "minimize";
    minimumImprovement: string;
    noiseTolerance: string;
    evaluatorConfig: unknown;
    metricCreatedAt: Date;
  },
): ProjectRead {
  const currentMetric: MetricDefinitionRead = {
    id: row.metricId,
    projectId: row.metricProjectId,
    version: row.metricVersion,
    name: row.metricName,
    unit: row.metricUnit,
    direction: row.metricDirection,
    minimumImprovement: row.minimumImprovement,
    noiseTolerance: row.noiseTolerance,
    evaluatorConfig: row.evaluatorConfig as JsonValue,
    guardrails: [],
    createdAt: row.metricCreatedAt,
  };

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    objective: row.objective,
    sourceType: row.sourceType,
    sourceReference: row.sourceReference,
    status: row.status,
    version: row.version,
    currentMetric,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRun(
  row: Omit<RunRead, "baseline" | "budget"> & {
    maximumExperiments: number;
    maximumDurationMs: number;
    maximumCostMinor: number;
    baselineAmount: string | null;
    baselineUnit: string | null;
  },
): RunRead {
  const {
    maximumExperiments,
    maximumDurationMs,
    maximumCostMinor,
    baselineAmount,
    baselineUnit,
    ...run
  } = row;

  return {
    ...run,
    budget: {
      maximumExperiments,
      maximumDurationMs,
      maximumCostMinor,
    },
    baseline:
      baselineAmount !== null && baselineUnit !== null
        ? { amount: baselineAmount, unit: baselineUnit }
        : null,
  };
}

export class PostgresReadRepository implements ReadRepository {
  constructor(private readonly database: Database) {}

  private currentMetrics() {
    return this.database
      .selectDistinctOn([schema.metricDefinitions.projectId], {
        projectId: schema.metricDefinitions.projectId,
        id: schema.metricDefinitions.id,
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
      .orderBy(
        schema.metricDefinitions.projectId,
        desc(schema.metricDefinitions.version),
      )
      .as("current_metrics");
  }

  async listProjects(input: {
    workspaceId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<ProjectRead>> {
    const currentMetrics = this.currentMetrics();
    const rows = await this.database
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        slug: schema.projects.slug,
        name: schema.projects.name,
        objective: schema.projects.objective,
        sourceType: schema.projects.sourceType,
        sourceReference: schema.projects.sourceReference,
        status: schema.projects.status,
        version: schema.projects.version,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
        metricId: currentMetrics.id,
        metricProjectId: currentMetrics.projectId,
        metricVersion: currentMetrics.version,
        metricName: currentMetrics.name,
        metricUnit: currentMetrics.unit,
        metricDirection: currentMetrics.direction,
        minimumImprovement: currentMetrics.minimumImprovement,
        noiseTolerance: currentMetrics.noiseTolerance,
        evaluatorConfig: currentMetrics.evaluatorConfig,
        metricCreatedAt: currentMetrics.createdAt,
      })
      .from(schema.projects)
      .innerJoin(
        currentMetrics,
        eq(currentMetrics.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.workspaceId, input.workspaceId),
          createdBefore(
            schema.projects.createdAt,
            schema.projects.id,
            input.cursor,
          ),
        ),
      )
      .orderBy(desc(schema.projects.createdAt), desc(schema.projects.id))
      .limit(input.limit + 1);

    return pageFromRows(rows.map(mapProject), input.limit);
  }

  async getProject(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectRead | null> {
    const currentMetrics = this.currentMetrics();
    const [row] = await this.database
      .select({
        id: schema.projects.id,
        workspaceId: schema.projects.workspaceId,
        slug: schema.projects.slug,
        name: schema.projects.name,
        objective: schema.projects.objective,
        sourceType: schema.projects.sourceType,
        sourceReference: schema.projects.sourceReference,
        status: schema.projects.status,
        version: schema.projects.version,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
        metricId: currentMetrics.id,
        metricProjectId: currentMetrics.projectId,
        metricVersion: currentMetrics.version,
        metricName: currentMetrics.name,
        metricUnit: currentMetrics.unit,
        metricDirection: currentMetrics.direction,
        minimumImprovement: currentMetrics.minimumImprovement,
        noiseTolerance: currentMetrics.noiseTolerance,
        evaluatorConfig: currentMetrics.evaluatorConfig,
        metricCreatedAt: currentMetrics.createdAt,
      })
      .from(schema.projects)
      .innerJoin(
        currentMetrics,
        eq(currentMetrics.projectId, schema.projects.id),
      )
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          eq(schema.projects.id, projectId),
        ),
      )
      .limit(1);

    if (!row) return null;

    const project = mapProject(row);
    const guardrails = await this.database
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
        eq(
          schema.constraintDefinitions.metricDefinitionId,
          project.currentMetric.id,
        ),
      )
      .orderBy(schema.constraintDefinitions.id);

    return {
      ...project,
      currentMetric: { ...project.currentMetric, guardrails },
    };
  }

  private async getMetricDefinition(
    metricDefinitionId: string,
  ): Promise<MetricDefinitionRead | null> {
    const [row] = await this.database
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
      .where(eq(schema.metricDefinitions.id, metricDefinitionId))
      .limit(1);

    if (!row) return null;

    const guardrails = await this.database
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

    return {
      ...row,
      evaluatorConfig: row.evaluatorConfig as JsonValue,
      guardrails,
    };
  }

  async listRuns(input: {
    workspaceId: string;
    projectId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<RunRead>> {
    const rows = await this.runQuery(
      and(
        eq(schema.projects.workspaceId, input.workspaceId),
        eq(schema.runs.projectId, input.projectId),
        createdBefore(schema.runs.createdAt, schema.runs.id, input.cursor),
      ),
      input.limit + 1,
    );

    return pageFromRows(rows, input.limit);
  }

  async getRun(
    workspaceId: string,
    runId: string,
  ): Promise<RunDetailRead | null> {
    const [row] = await this.runQuery(
      and(
        eq(schema.projects.workspaceId, workspaceId),
        eq(schema.runs.id, runId),
      ),
      1,
    );

    if (!row) return null;
    const metricDefinition = await this.getMetricDefinition(
      row.metricDefinitionId,
    );
    if (!metricDefinition) return null;

    return { ...row, metricDefinition };
  }

  private async runQuery(where: SQL | undefined, limit: number) {
    const rows = await this.database
      .select({
        id: schema.runs.id,
        projectId: schema.runs.projectId,
        metricDefinitionId: schema.runs.metricDefinitionId,
        sequence: schema.runs.sequence,
        title: schema.runs.title,
        objective: schema.runs.objective,
        status: schema.runs.status,
        version: schema.runs.version,
        latestEventSequence: sql<number>`coalesce(
          (
            select max(${schema.runEvents.sequence})
            from ${schema.runEvents}
            where ${schema.runEvents.runId} = ${schema.runs.id}
          ),
          0
        )::integer`,
        startedAt: schema.runs.startedAt,
        completedAt: schema.runs.completedAt,
        createdAt: schema.runs.createdAt,
        updatedAt: schema.runs.updatedAt,
        maximumExperiments: schema.runBudgets.maximumExperiments,
        maximumDurationMs: schema.runBudgets.maximumDurationMs,
        maximumCostMinor: schema.runBudgets.maximumCostMinor,
        baselineAmount: schema.observations.amount,
        baselineUnit: schema.observations.unit,
      })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .innerJoin(schema.runBudgets, eq(schema.runBudgets.runId, schema.runs.id))
      .leftJoin(
        schema.observations,
        and(
          eq(schema.observations.runId, schema.runs.id),
          eq(schema.observations.kind, "baseline"),
        ),
      )
      .where(where)
      .orderBy(desc(schema.runs.createdAt), desc(schema.runs.id))
      .limit(limit);

    return rows.map(mapRun);
  }

  async listExperiments(input: {
    workspaceId: string;
    runId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<ExperimentRead>> {
    const rows = await this.experimentQuery(
      and(
        eq(schema.projects.workspaceId, input.workspaceId),
        eq(schema.experiments.runId, input.runId),
        createdBefore(
          schema.experiments.createdAt,
          schema.experiments.id,
          input.cursor,
        ),
      ),
      input.limit + 1,
    );

    const page = pageFromRows(rows, input.limit);
    return {
      ...page,
      items: await this.hydrateExperiments(page.items),
    };
  }

  async getExperiment(
    workspaceId: string,
    experimentId: string,
  ): Promise<ExperimentRead | null> {
    const [row] = await this.experimentQuery(
      and(
        eq(schema.projects.workspaceId, workspaceId),
        eq(schema.experiments.id, experimentId),
      ),
      1,
    );

    if (!row) return null;
    const [hydrated] = await this.hydrateExperiments([row]);
    return hydrated ?? null;
  }

  private async experimentQuery(where: SQL | undefined, limit: number) {
    const rows = await this.database
      .select({
        id: schema.experiments.id,
        runId: schema.experiments.runId,
        parentExperimentId: schema.experiments.parentExperimentId,
        sequence: schema.experiments.sequence,
        hypothesis: schema.experiments.hypothesis,
        action: schema.experiments.action,
        status: schema.experiments.status,
        version: schema.experiments.version,
        estimatedDurationMs: schema.experiments.estimatedDurationMs,
        estimatedCostMinor: schema.experiments.estimatedCostMinor,
        startedAt: schema.experiments.startedAt,
        completedAt: schema.experiments.completedAt,
        createdAt: schema.experiments.createdAt,
        updatedAt: schema.experiments.updatedAt,
      })
      .from(schema.experiments)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.experiments.runId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(where)
      .orderBy(desc(schema.experiments.createdAt), desc(schema.experiments.id))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      observations: [],
      decision: null,
      learnings: [],
    }));
  }

  private async hydrateExperiments(
    experiments: readonly ExperimentRead[],
  ): Promise<ExperimentRead[]> {
    if (experiments.length === 0) return [];
    const experimentIds = experiments.map(({ id }) => id);

    const [observations, decisions, learningRows] = await Promise.all([
      this.database
        .select({
          id: schema.observations.id,
          experimentId: schema.observations.experimentId,
          kind: schema.observations.kind,
          metricDefinitionId: schema.observations.metricDefinitionId,
          constraintDefinitionId: schema.observations.constraintDefinitionId,
          amount: schema.observations.amount,
          unit: schema.observations.unit,
          sampleCount: schema.observations.sampleCount,
          notes: schema.observations.notes,
          recordedAt: schema.observations.recordedAt,
        })
        .from(schema.observations)
        .where(inArray(schema.observations.experimentId, experimentIds))
        .orderBy(schema.observations.recordedAt, schema.observations.id),
      this.database
        .select({
          id: schema.decisions.id,
          experimentId: schema.decisions.experimentId,
          policyVersion: schema.decisions.policyVersion,
          automatedDecision: schema.decisions.automatedDecision,
          reason: schema.decisions.reason,
          finalDecision: schema.decisions.finalDecision,
          overrideReason: schema.decisions.overrideReason,
          calculatedImprovement: schema.decisions.calculatedImprovement,
          createdAt: schema.decisions.createdAt,
        })
        .from(schema.decisions)
        .where(inArray(schema.decisions.experimentId, experimentIds))
        .orderBy(desc(schema.decisions.createdAt), desc(schema.decisions.id)),
      this.database
        .select({
          experimentId: schema.learningEvidence.experimentId,
          evidenceRole: schema.learningEvidence.role,
          id: schema.learnings.id,
          projectId: schema.learnings.projectId,
          statement: schema.learnings.statement,
          confidence: schema.learnings.confidence,
          status: schema.learnings.status,
          supersededLearningId: schema.learnings.supersededLearningId,
          createdAt: schema.learnings.createdAt,
          updatedAt: schema.learnings.updatedAt,
        })
        .from(schema.learningEvidence)
        .innerJoin(
          schema.learnings,
          eq(schema.learnings.id, schema.learningEvidence.learningId),
        )
        .where(inArray(schema.learningEvidence.experimentId, experimentIds))
        .orderBy(desc(schema.learnings.createdAt), desc(schema.learnings.id)),
    ]);

    return experiments.map((experiment) => {
      const decisionRow = decisions.find(
        ({ experimentId }) => experimentId === experiment.id,
      );
      const decision = decisionRow
        ? (({ experimentId, ...value }) => {
            void experimentId;
            return value;
          })(decisionRow)
        : null;

      return {
        ...experiment,
        observations: observations
          .filter(({ experimentId }) => experimentId === experiment.id)
          .map(({ experimentId, kind, ...observation }) => {
            void experimentId;
            return {
              ...observation,
              kind: kind as "before" | "after" | "guardrail",
            };
          }),
        decision,
        learnings: learningRows
          .filter(({ experimentId }) => experimentId === experiment.id)
          .map(({ experimentId, ...learning }) => {
            void experimentId;
            return learning;
          }),
      };
    });
  }

  async listLearnings(input: {
    workspaceId: string;
    projectId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<LearningRead>> {
    return this.learningPage(
      input.workspaceId,
      eq(schema.learnings.projectId, input.projectId),
      input.cursor,
      input.limit,
    );
  }

  async listWorkspaceLearnings(input: {
    workspaceId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<LearningRead>> {
    return this.learningPage(
      input.workspaceId,
      undefined,
      input.cursor,
      input.limit,
    );
  }

  private async learningPage(
    workspaceId: string,
    scope: SQL | undefined,
    cursor: CreatedCursor | null,
    limit: number,
  ): Promise<ReadPage<LearningRead>> {
    const rows = await this.database
      .select({
        id: schema.learnings.id,
        projectId: schema.learnings.projectId,
        statement: schema.learnings.statement,
        confidence: schema.learnings.confidence,
        status: schema.learnings.status,
        supersededLearningId: schema.learnings.supersededLearningId,
        createdAt: schema.learnings.createdAt,
        updatedAt: schema.learnings.updatedAt,
      })
      .from(schema.learnings)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.learnings.projectId),
      )
      .where(
        and(
          eq(schema.projects.workspaceId, workspaceId),
          scope,
          createdBefore(
            schema.learnings.createdAt,
            schema.learnings.id,
            cursor,
          ),
        ),
      )
      .orderBy(desc(schema.learnings.createdAt), desc(schema.learnings.id))
      .limit(limit + 1);

    return pageFromRows(rows, limit);
  }

  async listRunEvents(input: {
    workspaceId: string;
    runId: string;
    after: number;
    limit: number;
  }): Promise<EventReadPage<RunEventRead>> {
    const rows = await this.database
      .select({
        id: schema.runEvents.id,
        runId: schema.runEvents.runId,
        sequence: schema.runEvents.sequence,
        type: schema.runEvents.type,
        schemaVersion: schema.runEvents.schemaVersion,
        payload: schema.runEvents.payload,
        occurredAt: schema.runEvents.occurredAt,
      })
      .from(schema.runEvents)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.runEvents.runId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(
        and(
          eq(schema.projects.workspaceId, input.workspaceId),
          eq(schema.runEvents.runId, input.runId),
          gt(schema.runEvents.sequence, input.after),
        ),
      )
      .orderBy(asc(schema.runEvents.sequence))
      .limit(input.limit + 1);

    return eventPageFromRows(
      rows.map((row) => ({
        ...row,
        payload: row.payload as JsonValue,
      })),
      input.limit,
    );
  }
}
