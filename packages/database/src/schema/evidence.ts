import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { decisionReason, experimentDecision, observationKind } from "./enums";
import { canonicalDecimalCheck, positiveCheck } from "./helpers";
import { metricDefinitions } from "./projects";
import { experiments, runs } from "./runs";

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    experimentId: uuid("experiment_id"),
    kind: observationKind("kind").notNull(),
    metricDefinitionId: uuid("metric_definition_id")
      .notNull()
      .references(() => metricDefinitions.id),
    amount: text("amount").notNull(),
    unit: text("unit").notNull(),
    sampleCount: integer("sample_count").notNull(),
    notes: text("notes"),
    environment: jsonb("environment").notNull().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("observations_run_recorded_idx").on(table.runId, table.recordedAt),
    index("observations_experiment_idx").on(table.experimentId),
    foreignKey({
      name: "observations_experiment_same_run_fk",
      columns: [table.runId, table.experimentId],
      foreignColumns: [experiments.runId, experiments.id],
    }),
    canonicalDecimalCheck("observations_amount_canonical", table.amount),
    positiveCheck("observations_sample_count_positive", table.sampleCount),
    check(
      "observations_baseline_scope",
      sql`(${table.kind} = 'baseline' AND ${table.experimentId} IS NULL) OR (${table.kind} <> 'baseline' AND ${table.experimentId} IS NOT NULL)`,
    ),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    policyVersion: text("policy_version").notNull(),
    automatedDecision: experimentDecision("automated_decision").notNull(),
    reason: decisionReason("reason").notNull(),
    finalDecision: experimentDecision("final_decision").notNull(),
    overrideReason: text("override_reason"),
    calculatedImprovement: text("calculated_improvement").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("decisions_experiment_created_idx").on(
      table.experimentId,
      table.createdAt,
    ),
    uniqueIndex("decisions_single_root_per_experiment")
      .on(table.experimentId)
      .where(sql`${table.supersedesDecisionId} IS NULL`),
    uniqueIndex("decisions_single_successor").on(table.supersedesDecisionId),
    foreignKey({
      name: "decisions_superseded_same_experiment_fk",
      columns: [table.experimentId, table.supersedesDecisionId],
      foreignColumns: [table.experimentId, table.id],
    }),
    unique("decisions_experiment_id_unique").on(table.experimentId, table.id),
    canonicalDecimalCheck(
      "decisions_calculated_improvement_canonical",
      table.calculatedImprovement,
    ),
    check(
      "decisions_override_reason_consistent",
      sql`(${table.finalDecision} = ${table.automatedDecision} AND ${table.overrideReason} IS NULL) OR (${table.finalDecision} <> ${table.automatedDecision} AND ${table.overrideReason} IS NOT NULL)`,
    ),
  ],
);
