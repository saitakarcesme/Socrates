import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { evidenceRole, learningStatus } from "./enums";
import { experiments } from "./runs";
import { projects } from "./projects";

export const learnings = pgTable(
  "learnings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    statement: text("statement").notNull(),
    confidence: real("confidence").notNull(),
    status: learningStatus("status").default("active").notNull(),
    supersededLearningId: uuid("superseded_learning_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("learnings_project_status_idx").on(table.projectId, table.status),
    unique("learnings_project_id_unique").on(table.projectId, table.id),
    uniqueIndex("learnings_single_successor").on(table.supersededLearningId),
    foreignKey({
      name: "learnings_superseded_same_project_fk",
      columns: [table.projectId, table.supersededLearningId],
      foreignColumns: [table.projectId, table.id],
    }),
    check(
      "learnings_confidence_range",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
  ],
);

export const learningEvidence = pgTable(
  "learning_evidence",
  {
    learningId: uuid("learning_id")
      .notNull()
      .references(() => learnings.id),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id),
    role: evidenceRole("role").notNull(),
  },
  (table) => [
    primaryKey({
      name: "learning_evidence_pk",
      columns: [table.learningId, table.experimentId],
    }),
    index("learning_evidence_experiment_idx").on(table.experimentId),
  ],
);
