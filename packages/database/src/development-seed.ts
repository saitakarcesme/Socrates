import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index";

export const developmentSeedIds = {
  workspace: "019c1170-8b7a-7a60-b7f8-f35c85d75000",
  atlasProject: "019c1170-8b7a-7a60-b7f8-f35c85d75001",
  atlasMetric: "019c1170-8b7a-7a60-b7f8-f35c85d75002",
  atlasRun: "019c1170-8b7a-7a60-b7f8-f35c85d75003",
  atlasBaseline: "019c1170-8b7a-7a60-b7f8-f35c85d75004",
  atlasExperiment: "019c1170-8b7a-7a60-b7f8-f35c85d75005",
  atlasExperimentTwo: "019c1170-8b7a-7a60-b7f8-f35c85d75006",
  atlasLearning: "019c1170-8b7a-7a60-b7f8-f35c85d75007",
  atlasLearningTwo: "019c1170-8b7a-7a60-b7f8-f35c85d75008",
  atlasEvent: "019c1170-8b7a-7a60-b7f8-f35c85d75009",
  atlasEventTwo: "019c1170-8b7a-7a60-b7f8-f35c85d75010",
  evalProject: "019c1170-8b7a-7a60-b7f8-f35c85d75011",
  evalMetric: "019c1170-8b7a-7a60-b7f8-f35c85d75012",
  atlasBefore: "019c1170-8b7a-7a60-b7f8-f35c85d75013",
  atlasAfter: "019c1170-8b7a-7a60-b7f8-f35c85d75014",
  atlasDecision: "019c1170-8b7a-7a60-b7f8-f35c85d75015",
  atlasGuardrail: "019c1170-8b7a-7a60-b7f8-f35c85d75016",
  atlasGuardrailObservation: "019c1170-8b7a-7a60-b7f8-f35c85d75017",
} as const;

export async function seedEmptyDevelopmentWorkspace(
  connectionString: string,
  input: { id: string; name: string },
) {
  const client = postgres(connectionString, { max: 1 });
  const database = drizzle(client, { schema });

  try {
    await database
      .insert(schema.workspaces)
      .values(input)
      .onConflictDoNothing();
  } finally {
    await client.end();
  }
}

export async function seedDevelopmentData(connectionString: string) {
  const client = postgres(connectionString, { max: 1 });
  const database = drizzle(client, { schema });
  const ids = developmentSeedIds;

  try {
    await database.transaction(async (transaction) => {
      await transaction
        .insert(schema.workspaces)
        .values({
          id: ids.workspace,
          name: "Socrates Development",
          createdAt: new Date("2026-01-01T08:00:00.000Z"),
          updatedAt: new Date("2026-01-01T08:00:00.000Z"),
        })
        .onConflictDoNothing();

      await transaction
        .insert(schema.projects)
        .values([
          {
            id: ids.atlasProject,
            workspaceId: ids.workspace,
            name: "Atlas Web",
            slug: "atlas-web",
            objective: "Reduce p75 LCP without regressing conversion.",
            sourceType: "website",
            sourceReference: "https://example.com",
            createdAt: new Date("2026-01-03T08:00:00.000Z"),
            updatedAt: new Date("2026-01-03T08:00:00.000Z"),
          },
          {
            id: ids.evalProject,
            workspaceId: ids.workspace,
            name: "Meridian Eval",
            slug: "meridian-eval",
            objective: "Improve benchmark accuracy at fixed inference cost.",
            sourceType: "model",
            sourceReference: "hf://socrates/meridian",
            createdAt: new Date("2026-01-02T08:00:00.000Z"),
            updatedAt: new Date("2026-01-02T08:00:00.000Z"),
          },
        ])
        .onConflictDoNothing();

      await transaction
        .insert(schema.metricDefinitions)
        .values([
          {
            id: ids.atlasMetric,
            projectId: ids.atlasProject,
            version: 1,
            name: "p75 LCP",
            unit: "s",
            direction: "minimize",
            minimumImprovement: "0.05",
            noiseTolerance: "0.01",
            evaluatorConfig: { entry: "manual" },
            createdAt: new Date("2026-01-03T08:01:00.000Z"),
          },
          {
            id: ids.evalMetric,
            projectId: ids.evalProject,
            version: 1,
            name: "Accuracy",
            unit: "ratio",
            direction: "maximize",
            minimumImprovement: "0.005",
            noiseTolerance: "0.001",
            evaluatorConfig: { entry: "manual" },
            createdAt: new Date("2026-01-02T08:01:00.000Z"),
          },
        ])
        .onConflictDoNothing();
      await transaction
        .insert(schema.constraintDefinitions)
        .values({
          id: ids.atlasGuardrail,
          metricDefinitionId: ids.atlasMetric,
          name: "LCP ceiling",
          unit: "s",
          operator: "less_than_or_equal",
          threshold: "3",
          hard: true,
        })
        .onConflictDoNothing();

      await transaction
        .insert(schema.runs)
        .values({
          id: ids.atlasRun,
          projectId: ids.atlasProject,
          metricDefinitionId: ids.atlasMetric,
          sequence: 1,
          title: "Critical rendering path",
          objective: "Reduce p75 LCP.",
          status: "running",
          version: 2,
          startedAt: new Date("2026-01-04T08:00:00.000Z"),
          createdAt: new Date("2026-01-04T07:55:00.000Z"),
          updatedAt: new Date("2026-01-04T08:05:00.000Z"),
        })
        .onConflictDoNothing();
      await transaction
        .insert(schema.runBudgets)
        .values({
          runId: ids.atlasRun,
          maximumExperiments: 10,
          maximumDurationMs: 3_600_000,
          maximumCostMinor: 2_000,
        })
        .onConflictDoNothing();
      await transaction
        .insert(schema.observations)
        .values({
          id: ids.atlasBaseline,
          runId: ids.atlasRun,
          kind: "baseline",
          metricDefinitionId: ids.atlasMetric,
          amount: "2.4",
          unit: "s",
          sampleCount: 5,
          recordedAt: new Date("2026-01-04T08:01:00.000Z"),
        })
        .onConflictDoNothing();

      await transaction
        .insert(schema.experiments)
        .values([
          {
            id: ids.atlasExperiment,
            runId: ids.atlasRun,
            sequence: 1,
            hypothesis: "Inlining critical CSS will improve LCP.",
            action: "Inline above-the-fold CSS.",
            status: "kept",
            version: 4,
            estimatedDurationMs: 300_000,
            estimatedCostMinor: 100,
            startedAt: new Date("2026-01-04T08:10:00.000Z"),
            completedAt: new Date("2026-01-04T08:15:00.000Z"),
            createdAt: new Date("2026-01-04T08:09:00.000Z"),
            updatedAt: new Date("2026-01-04T08:15:00.000Z"),
          },
          {
            id: ids.atlasExperimentTwo,
            runId: ids.atlasRun,
            parentExperimentId: ids.atlasExperiment,
            sequence: 2,
            hypothesis: "Preloading the hero asset will improve LCP.",
            action: "Add a high-priority preload.",
            status: "proposed",
            version: 0,
            estimatedDurationMs: 180_000,
            estimatedCostMinor: 50,
            createdAt: new Date("2026-01-04T08:20:00.000Z"),
            updatedAt: new Date("2026-01-04T08:20:00.000Z"),
          },
        ])
        .onConflictDoNothing();
      await transaction
        .insert(schema.observations)
        .values([
          {
            id: ids.atlasBefore,
            runId: ids.atlasRun,
            experimentId: ids.atlasExperiment,
            kind: "before",
            metricDefinitionId: ids.atlasMetric,
            amount: "2.4",
            unit: "s",
            sampleCount: 5,
            recordedAt: new Date("2026-01-04T08:11:00.000Z"),
          },
          {
            id: ids.atlasAfter,
            runId: ids.atlasRun,
            experimentId: ids.atlasExperiment,
            kind: "after",
            metricDefinitionId: ids.atlasMetric,
            amount: "2.2",
            unit: "s",
            sampleCount: 5,
            recordedAt: new Date("2026-01-04T08:14:00.000Z"),
          },
          {
            id: ids.atlasGuardrailObservation,
            runId: ids.atlasRun,
            experimentId: ids.atlasExperiment,
            kind: "guardrail",
            constraintDefinitionId: ids.atlasGuardrail,
            amount: "2.2",
            unit: "s",
            sampleCount: 5,
            recordedAt: new Date("2026-01-04T08:14:30.000Z"),
          },
        ])
        .onConflictDoNothing();
      await transaction
        .insert(schema.decisions)
        .values({
          id: ids.atlasDecision,
          experimentId: ids.atlasExperiment,
          policyVersion: "manual-experiment-v1",
          automatedDecision: "kept",
          reason: "improved",
          finalDecision: "kept",
          calculatedImprovement: "0.2",
          createdAt: new Date("2026-01-04T08:15:00.000Z"),
        })
        .onConflictDoNothing();

      await transaction
        .insert(schema.learnings)
        .values([
          {
            id: ids.atlasLearning,
            projectId: ids.atlasProject,
            statement: "Critical CSS is the highest-leverage LCP intervention.",
            confidence: 0.86,
            createdAt: new Date("2026-01-04T08:16:00.000Z"),
            updatedAt: new Date("2026-01-04T08:16:00.000Z"),
          },
          {
            id: ids.atlasLearningTwo,
            projectId: ids.atlasProject,
            statement:
              "Hero preloading should be measured after CSS stabilization.",
            confidence: 0.62,
            createdAt: new Date("2026-01-04T08:17:00.000Z"),
            updatedAt: new Date("2026-01-04T08:17:00.000Z"),
          },
        ])
        .onConflictDoNothing();
      await transaction
        .insert(schema.learningEvidence)
        .values([
          {
            learningId: ids.atlasLearning,
            experimentId: ids.atlasExperiment,
            role: "supports",
          },
          {
            learningId: ids.atlasLearningTwo,
            experimentId: ids.atlasExperiment,
            role: "supports",
          },
        ])
        .onConflictDoNothing();

      await transaction
        .insert(schema.runEvents)
        .values([
          {
            id: ids.atlasEvent,
            runId: ids.atlasRun,
            sequence: 1,
            type: "run.started",
            schemaVersion: "1",
            payload: { status: "running" },
            occurredAt: new Date("2026-01-04T08:00:00.000Z"),
          },
          {
            id: ids.atlasEventTwo,
            runId: ids.atlasRun,
            sequence: 2,
            type: "experiment.proposed",
            schemaVersion: "1",
            payload: { experimentId: ids.atlasExperiment },
            occurredAt: new Date("2026-01-04T08:09:00.000Z"),
          },
        ])
        .onConflictDoNothing();
    });
  } finally {
    await client.end();
  }
}
