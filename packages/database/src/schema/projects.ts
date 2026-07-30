import { sql } from "drizzle-orm";
import {
  boolean,
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

import {
  constraintOperator,
  metricDirection,
  projectStatus,
  sourceType,
} from "./enums";
import {
  canonicalDecimalCheck,
  nonNegativeCheck,
  positiveCheck,
} from "./helpers";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    objective: text("objective").notNull(),
    sourceType: sourceType("source_type"),
    sourceReference: text("source_reference"),
    status: projectStatus("status").default("active").notNull(),
    version: integer("version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("projects_workspace_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("projects_workspace_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
    index("projects_workspace_status_idx").on(table.workspaceId, table.status),
    index("projects_workspace_created_id_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    nonNegativeCheck("projects_version_non_negative", table.version),
    check(
      "projects_source_complete",
      sql`(${table.sourceType} IS NULL) = (${table.sourceReference} IS NULL)`,
    ),
  ],
);

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    direction: metricDirection("direction").notNull(),
    minimumImprovement: text("minimum_improvement").notNull(),
    noiseTolerance: text("noise_tolerance").notNull(),
    evaluatorConfig: jsonb("evaluator_config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("metric_definitions_project_version_unique").on(
      table.projectId,
      table.version,
    ),
    unique("metric_definitions_project_id_unique").on(
      table.projectId,
      table.id,
    ),
    positiveCheck("metric_definitions_version_positive", table.version),
    canonicalDecimalCheck(
      "metric_definitions_minimum_improvement_canonical",
      table.minimumImprovement,
    ),
    canonicalDecimalCheck(
      "metric_definitions_noise_tolerance_canonical",
      table.noiseTolerance,
    ),
    check(
      "metric_definitions_minimum_improvement_non_negative",
      sql`${table.minimumImprovement} !~ '^-'`,
    ),
    check(
      "metric_definitions_noise_tolerance_non_negative",
      sql`${table.noiseTolerance} !~ '^-'`,
    ),
  ],
);

export const constraintDefinitions = pgTable(
  "constraint_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    metricDefinitionId: uuid("metric_definition_id").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    operator: constraintOperator("operator").notNull(),
    threshold: text("threshold").notNull(),
    hard: boolean("hard").notNull(),
  },
  (table) => [
    index("constraint_definitions_metric_idx").on(table.metricDefinitionId),
    foreignKey({
      name: "constraints_metric_definition_fk",
      columns: [table.metricDefinitionId],
      foreignColumns: [metricDefinitions.id],
    }),
    canonicalDecimalCheck(
      "constraint_definitions_threshold_canonical",
      table.threshold,
    ),
  ],
);
