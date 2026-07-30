import {
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  sequence: integer("sequence").notNull(),
  status: runStatus("status").notNull(),
  budgetMinor: integer("budget_minor").notNull(),
  spentMinor: integer("spent_minor").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const experiments = pgTable("experiments", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  parentExperimentId: uuid("parent_experiment_id"),
  sequence: integer("sequence").notNull(),
  hypothesis: text("hypothesis").notNull(),
  action: text("action").notNull(),
  metricBefore: numeric("metric_before"),
  metricAfter: numeric("metric_after"),
  decision: text("decision"),
  learnedKnowledge: text("learned_knowledge"),
});

export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});
