import type {
  ExperimentRead,
  LearningRead,
  ProjectRead,
  RunEventRead,
  RunRead,
} from "@socrates/database";

function iso(value: Date): string {
  return value.toISOString();
}

function nullableIso(value: Date | null): string | null {
  return value ? iso(value) : null;
}

export function mapProjectSummary(project: ProjectRead) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    slug: project.slug,
    name: project.name,
    objective: project.objective,
    status: project.status,
    version: project.version,
    currentMetricDefinitionId: project.currentMetric.id,
    currentMetric: {
      name: project.currentMetric.name,
      unit: project.currentMetric.unit,
      direction: project.currentMetric.direction,
    },
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  };
}

export function mapProjectDetail(project: ProjectRead) {
  const evaluatorConfig = project.currentMetric.evaluatorConfig;

  return {
    ...mapProjectSummary(project),
    source:
      project.sourceType && project.sourceReference
        ? {
            type: project.sourceType,
            reference: project.sourceReference,
          }
        : null,
    currentMetric: {
      id: project.currentMetric.id,
      projectId: project.currentMetric.projectId,
      version: project.currentMetric.version,
      name: project.currentMetric.name,
      unit: project.currentMetric.unit,
      direction: project.currentMetric.direction,
      minimumImprovement: project.currentMetric.minimumImprovement,
      noiseTolerance: project.currentMetric.noiseTolerance,
      evaluatorConfig:
        evaluatorConfig &&
        typeof evaluatorConfig === "object" &&
        !Array.isArray(evaluatorConfig)
          ? evaluatorConfig
          : {},
      guardrails: project.currentMetric.guardrails,
      createdAt: iso(project.currentMetric.createdAt),
    },
  };
}

export function mapRun(run: RunRead) {
  return {
    ...run,
    startedAt: nullableIso(run.startedAt),
    completedAt: nullableIso(run.completedAt),
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
  };
}

export function mapExperiment(experiment: ExperimentRead) {
  return {
    ...experiment,
    observations: experiment.observations.map((observation) => ({
      id: observation.id,
      kind: observation.kind,
      metricDefinitionId: observation.metricDefinitionId,
      constraintDefinitionId: observation.constraintDefinitionId,
      value: { amount: observation.amount, unit: observation.unit },
      sampleCount: observation.sampleCount,
      notes: observation.notes,
      recordedAt: iso(observation.recordedAt),
    })),
    decision: experiment.decision
      ? {
          ...experiment.decision,
          createdAt: iso(experiment.decision.createdAt),
        }
      : null,
    learnings: experiment.learnings.map(mapLearning),
    startedAt: nullableIso(experiment.startedAt),
    completedAt: nullableIso(experiment.completedAt),
    createdAt: iso(experiment.createdAt),
    updatedAt: iso(experiment.updatedAt),
  };
}

export function mapLearning(learning: LearningRead) {
  return {
    ...learning,
    createdAt: iso(learning.createdAt),
    updatedAt: iso(learning.updatedAt),
  };
}

export function mapRunEvent(event: RunEventRead) {
  return {
    ...event,
    occurredAt: iso(event.occurredAt),
  };
}
