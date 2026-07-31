import { pgEnum } from "drizzle-orm/pg-core";

export const projectStatus = pgEnum("project_status", [
  "active",
  "paused",
  "completed",
  "archived",
]);

export const sourceType = pgEnum("source_type", [
  "repository",
  "website",
  "dataset",
  "model",
  "other",
]);

export const metricDirection = pgEnum("metric_direction", [
  "maximize",
  "minimize",
]);

export const constraintOperator = pgEnum("constraint_operator", [
  "less_than",
  "less_than_or_equal",
  "greater_than",
  "greater_than_or_equal",
]);

export const runStatus = pgEnum("run_status", [
  "draft",
  "queued",
  "preparing",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "budget_exhausted",
]);

export const experimentStatus = pgEnum("experiment_status", [
  "proposed",
  "queued",
  "executing",
  "measuring",
  "evaluating",
  "failed",
  "kept",
  "discarded",
  "inconclusive",
]);

export const observationKind = pgEnum("observation_kind", [
  "baseline",
  "before",
  "after",
  "guardrail",
]);

export const experimentDecision = pgEnum("experiment_decision", [
  "kept",
  "discarded",
  "inconclusive",
]);

export const decisionReason = pgEnum("decision_reason", [
  "improved",
  "within_noise",
  "below_threshold",
  "guardrail_failed",
  "invalid_measurement",
]);

export const learningStatus = pgEnum("learning_status", [
  "active",
  "superseded",
  "retracted",
]);

export const evidenceRole = pgEnum("evidence_role", [
  "supports",
  "contradicts",
]);

export const runnerKind = pgEnum("runner_kind", [
  "local",
  "cloud",
  "distributed",
]);

export const runnerRegistrationStatus = pgEnum("runner_registration_status", [
  "active",
  "draining",
  "offline",
]);

export const runnerTaskStatus = pgEnum("runner_task_status", [
  "queued",
  "leased",
  "running",
  "cancellation_requested",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runnerAttemptStatus = pgEnum("runner_attempt_status", [
  "claimed",
  "preparing",
  "executing",
  "measuring",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const artifactRetentionClass = pgEnum("artifact_retention_class", [
  "run_evidence",
]);
