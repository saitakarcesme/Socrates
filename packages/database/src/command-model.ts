import type { ConstraintOperator } from "@socrates/domain";

import type { JsonValue } from "./json";
import type {
  ExperimentRead,
  MetricDefinitionRead,
  RunRead,
} from "./read-model";

export type ConstraintDefinitionRecord = {
  id: string;
  metricDefinitionId: string;
  name: string;
  unit: string;
  operator: ConstraintOperator;
  threshold: string;
  hard: boolean;
};

export type ProjectCommandRecord = {
  id: string;
  workspaceId: string;
  version: number;
  currentMetricVersion: number;
  currentMetricDefinitionId: string;
};

export type RunCommandRecord = {
  id: string;
  projectId: string;
  metricDefinitionId: string;
  version: number;
  status: RunRead["status"];
  budget: RunRead["budget"];
  baseline: RunRead["baseline"];
  metric: MetricDefinitionRead;
  constraints: readonly ConstraintDefinitionRecord[];
};

export type ExperimentCommandRecord = {
  id: string;
  runId: string;
  projectId: string;
  version: number;
  status: ExperimentRead["status"];
  run: RunCommandRecord;
};

export type RunUsageRecord = {
  experiments: number;
  durationMs: number;
  costMinor: number;
};

export type DecisionEvidenceRecord = {
  before: { amount: string; unit: string } | null;
  after: { amount: string; unit: string } | null;
  guardrails: readonly {
    constraint: ConstraintDefinitionRecord;
    observation: { amount: string; unit: string } | null;
  }[];
};

export type MetricDefinitionWrite = {
  id: string;
  projectId: string;
  version: number;
  name: string;
  unit: string;
  direction: "maximize" | "minimize";
  minimumImprovement: string;
  noiseTolerance: string;
  evaluatorConfig?: JsonValue;
  guardrails: readonly {
    id: string;
    name: string;
    unit: string;
    operator: ConstraintOperator;
    threshold: string;
    hard: boolean;
  }[];
};

export type CreateProjectWrite = {
  id: string;
  metric: MetricDefinitionWrite;
  workspaceId: string;
  name: string;
  slug: string;
  objective: string;
  sourceType: "repository" | "website" | "dataset" | "model" | "other" | null;
  sourceReference: string | null;
};

export type CreateProjectResult =
  | { state: "created" }
  | { state: "workspace_not_found" }
  | { state: "slug_conflict" };

export interface CommandRepository {
  createProject(input: CreateProjectWrite): Promise<CreateProjectResult>;
  lockProject(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectCommandRecord | null>;
  addMetricDefinition(
    metric: MetricDefinitionWrite,
    expectedProjectVersion: number,
  ): Promise<boolean>;
  createRun(
    input: {
      id: string;
      projectId: string;
      metricDefinitionId: string;
      title: string;
      objective: string;
      budget: RunRead["budget"];
    },
    expectedProjectVersion: number,
  ): Promise<{ sequence: number } | null>;
  lockRun(workspaceId: string, runId: string): Promise<RunCommandRecord | null>;
  getRunUsage(runId: string): Promise<RunUsageRecord>;
  countOpenExperiments(runId: string): Promise<number>;
  recordBaseline(input: {
    id: string;
    runId: string;
    metricDefinitionId: string;
    amount: string;
    unit: string;
    sampleCount: number;
    notes?: string;
  }): Promise<void>;
  updateRun(input: {
    runId: string;
    expectedVersion: number;
    status?: RunRead["status"];
    startedAt?: Date;
    completedAt?: Date;
  }): Promise<boolean>;
  parentExperimentExists(runId: string, experimentId: string): Promise<boolean>;
  createExperiment(
    input: {
      id: string;
      runId: string;
      parentExperimentId: string | null;
      hypothesis: string;
      action: string;
      estimatedDurationMs: number;
      estimatedCostMinor: number;
    },
    expectedRunVersion: number,
  ): Promise<{ sequence: number } | null>;
  lockExperiment(
    workspaceId: string,
    experimentId: string,
  ): Promise<ExperimentCommandRecord | null>;
  updateExperiment(input: {
    experimentId: string;
    expectedVersion: number;
    status?: ExperimentRead["status"];
    startedAt?: Date;
    completedAt?: Date;
  }): Promise<boolean>;
  recordObservation(input: {
    id: string;
    runId: string;
    experimentId: string;
    kind: "before" | "after" | "guardrail";
    metricDefinitionId: string | null;
    constraintDefinitionId: string | null;
    amount: string;
    unit: string;
    sampleCount: number;
    notes?: string;
  }): Promise<void>;
  loadDecisionEvidence(
    experiment: ExperimentCommandRecord,
  ): Promise<DecisionEvidenceRecord>;
  recordDecision(input: {
    id: string;
    experimentId: string;
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
  }): Promise<void>;
  recordLearning(input: {
    id: string;
    projectId: string;
    experimentId: string;
    statement: string;
    confidence: number;
    evidenceRole: "supports" | "contradicts";
  }): Promise<void>;
}
