import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { positiveCheck } from "./helpers";
import { workspaces } from "./projects";
import { runs } from "./runs";

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("run_events_run_sequence_unique").on(
      table.runId,
      table.sequence,
    ),
    index("run_events_run_occurred_idx").on(table.runId, table.occurredAt),
    positiveCheck("run_events_sequence_positive", table.sequence),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    commandName: text("command_name").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "idempotency_keys_pk",
      columns: [table.workspaceId, table.key],
    }),
    index("idempotency_keys_created_idx").on(table.createdAt),
    check(
      "idempotency_keys_response_complete",
      sql`(${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL AND ${table.completedAt} IS NULL) OR (${table.responseStatus} BETWEEN 100 AND 599 AND ${table.responseBody} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);
