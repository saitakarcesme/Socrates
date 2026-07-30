import { randomUUID } from "node:crypto";

import type { CreateProjectCommand } from "@socrates/contracts";
import type {
  JsonValue,
  MetricDefinitionWrite,
  TransactionRepositories,
} from "@socrates/database";

import { versionConflict } from "../errors";
import type { CommandResponse } from "../idempotency";

export type CommandContext = {
  workspaceId: string;
  idempotencyKey: string;
};

export function assertVersion(expected: number, actual: number): void {
  if (expected !== actual) {
    versionConflict(expected, actual);
  }
}

export function commandResponse(
  status: number,
  body: JsonValue,
): CommandResponse {
  return { status, body };
}

export function createMetricWrite(
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

export function guardrailResources(metric: MetricDefinitionWrite) {
  return metric.guardrails.map((guardrail) => ({
    constraintDefinitionId: guardrail.id,
    name: guardrail.name,
    unit: guardrail.unit,
  }));
}

export async function appendRunEvent(
  repositories: TransactionRepositories,
  runId: string,
  type: string,
  payload: JsonValue,
): Promise<void> {
  await repositories.runEvents.append({
    runId,
    type,
    schemaVersion: "1",
    payload,
  });
}
