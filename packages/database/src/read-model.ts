import type { JsonValue } from "./json";

export type CreatedCursor = {
  createdAt: Date;
  id: string;
};

export type ReadPage<T> = {
  items: readonly T[];
  nextCursor: CreatedCursor | null;
};

export type EventReadPage<T> = {
  items: readonly T[];
  nextCursor: number | null;
};

export type MetricDefinitionRead = {
  id: string;
  projectId: string;
  version: number;
  name: string;
  unit: string;
  direction: "maximize" | "minimize";
  minimumImprovement: string;
  noiseTolerance: string;
  evaluatorConfig: JsonValue;
  guardrails: readonly {
    id: string;
    metricDefinitionId: string;
    name: string;
    unit: string;
    operator:
      | "less_than"
      | "less_than_or_equal"
      | "greater_than"
      | "greater_than_or_equal";
    threshold: string;
    hard: boolean;
  }[];
  createdAt: Date;
};

export type ProjectRead = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  objective: string;
  sourceType: "repository" | "website" | "dataset" | "model" | "other" | null;
  sourceReference: string | null;
  status: "active" | "paused" | "completed" | "archived";
  version: number;
  currentMetric: MetricDefinitionRead;
  createdAt: Date;
  updatedAt: Date;
};

export type RunRead = {
  id: string;
  projectId: string;
  metricDefinitionId: string;
  sequence: number;
  title: string;
  objective: string;
  status:
    | "draft"
    | "queued"
    | "preparing"
    | "running"
    | "paused"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed"
    | "budget_exhausted";
  version: number;
  budget: {
    maximumExperiments: number;
    maximumDurationMs: number;
    maximumCostMinor: number;
  };
  baseline: { amount: string; unit: string } | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ExperimentRead = {
  id: string;
  runId: string;
  parentExperimentId: string | null;
  sequence: number;
  hypothesis: string;
  action: string;
  status:
    | "proposed"
    | "queued"
    | "executing"
    | "measuring"
    | "evaluating"
    | "failed"
    | "kept"
    | "discarded"
    | "inconclusive";
  version: number;
  estimatedDurationMs: number;
  estimatedCostMinor: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  observations: readonly ExperimentObservationRead[];
  decision: ExperimentDecisionRead | null;
  learnings: readonly ExperimentLearningRead[];
};

export type ExperimentObservationRead = {
  id: string;
  kind: "before" | "after" | "guardrail";
  metricDefinitionId: string | null;
  constraintDefinitionId: string | null;
  amount: string;
  unit: string;
  sampleCount: number;
  notes: string | null;
  recordedAt: Date;
};

export type ExperimentDecisionRead = {
  id: string;
  policyVersion: string;
  automatedDecision: "kept" | "discarded" | "inconclusive";
  reason:
    | "improved"
    | "within_noise"
    | "below_threshold"
    | "guardrail_failed"
    | "invalid_measurement";
  finalDecision: "kept" | "discarded" | "inconclusive";
  overrideReason: string | null;
  calculatedImprovement: string;
  createdAt: Date;
};

export type ExperimentLearningRead = LearningRead & {
  evidenceRole: "supports" | "contradicts";
};

export type LearningRead = {
  id: string;
  projectId: string;
  statement: string;
  confidence: number;
  status: "active" | "superseded" | "retracted";
  supersededLearningId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RunEventRead = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt: Date;
};

export interface ReadRepository {
  listProjects(input: {
    workspaceId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<ProjectRead>>;
  getProject(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectRead | null>;
  listRuns(input: {
    workspaceId: string;
    projectId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<RunRead>>;
  getRun(workspaceId: string, runId: string): Promise<RunRead | null>;
  listExperiments(input: {
    workspaceId: string;
    runId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<ExperimentRead>>;
  getExperiment(
    workspaceId: string,
    experimentId: string,
  ): Promise<ExperimentRead | null>;
  listLearnings(input: {
    workspaceId: string;
    projectId: string;
    cursor: CreatedCursor | null;
    limit: number;
  }): Promise<ReadPage<LearningRead>>;
  listRunEvents(input: {
    workspaceId: string;
    runId: string;
    after: number;
    limit: number;
  }): Promise<EventReadPage<RunEventRead>>;
}
