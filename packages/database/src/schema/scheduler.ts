import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  artifactRetentionClass,
  runnerAttemptStatus,
  runnerKind,
  runnerRegistrationStatus,
  runnerTaskStatus,
} from "./enums";
import { nonNegativeCheck, positiveCheck } from "./helpers";
import { projects, workspaces } from "./projects";
import { experiments, runs } from "./runs";

export const runnerRegistrations = pgTable(
  "runner_registrations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: runnerKind("kind").notNull(),
    status: runnerRegistrationStatus("status").default("active").notNull(),
    softwareVersion: text("software_version").notNull(),
    taskProtocolVersions: text("task_protocol_versions").array().notNull(),
    eventProtocolVersions: text("event_protocol_versions").array().notNull(),
    sandboxBackend: text("sandbox_backend").notNull(),
    capabilities: jsonb("capabilities").notNull(),
    maximumConcurrentTasks: integer("maximum_concurrent_tasks").notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("runner_registrations_workspace_status_heartbeat_idx").on(
      table.workspaceId,
      table.status,
      table.lastHeartbeatAt,
    ),
    positiveCheck(
      "runner_registrations_capacity_positive",
      table.maximumConcurrentTasks,
    ),
    check(
      "runner_registrations_task_protocol_v2",
      sql`'2' = ANY(${table.taskProtocolVersions})`,
    ),
    check(
      "runner_registrations_event_protocol_v2",
      sql`'2' = ANY(${table.eventProtocolVersions})`,
    ),
    check(
      "runner_registrations_oci_backend",
      sql`${table.sandboxBackend} = 'oci'`,
    ),
  ],
);

export const runnerRegistrationTokens = pgTable(
  "runner_registration_tokens",
  {
    id: uuid("id").primaryKey(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runnerRegistrations.id),
    secretDigest: text("secret_digest").notNull(),
    label: text("label").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_registration_tokens_secret_digest_unique").on(
      table.secretDigest,
    ),
    index("runner_registration_tokens_runner_active_expiry_idx")
      .on(table.runnerId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "runner_registration_tokens_secret_digest_sha256",
      sql`${table.secretDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "runner_registration_tokens_label_length",
      sql`length(${table.label}) BETWEEN 1 AND 80 AND ${table.label} = btrim(${table.label})`,
    ),
    check(
      "runner_registration_tokens_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "runner_registration_tokens_revocation_after_creation",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const runnerTasks = pgTable(
  "runner_tasks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id),
    protocolVersion: text("protocol_version").notNull(),
    payload: jsonb("payload").notNull(),
    requiredCapabilities: jsonb("required_capabilities").notNull(),
    status: runnerTaskStatus("status").default("queued").notNull(),
    retrySafe: boolean("retry_safe").notNull(),
    currentFence: integer("current_fence").default(0).notNull(),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
    }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_tasks_experiment_unique").on(table.experimentId),
    index("runner_tasks_workspace_queue_created_id_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("runner_tasks_run_created_id_idx").on(
      table.runId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "runner_tasks_project_same_workspace_fk",
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({
      name: "runner_tasks_run_same_project_fk",
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
    }),
    foreignKey({
      name: "runner_tasks_experiment_same_run_fk",
      columns: [table.runId, table.experimentId],
      foreignColumns: [experiments.runId, experiments.id],
    }),
    nonNegativeCheck(
      "runner_tasks_current_fence_non_negative",
      table.currentFence,
    ),
    check("runner_tasks_protocol_v2", sql`${table.protocolVersion} = '2'`),
    check(
      "runner_tasks_terminal_state",
      sql`(${table.status} IN ('succeeded', 'failed', 'cancelled')) = (${table.terminalAt} IS NOT NULL)`,
    ),
  ],
);

export const runnerTaskAttempts = pgTable(
  "runner_task_attempts",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => runnerTasks.id),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runnerRegistrations.id),
    fence: integer("fence").notNull(),
    status: runnerAttemptStatus("status").default("claimed").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    lastEventSequence: integer("last_event_sequence").default(0).notNull(),
    acceptedLogBytes: bigint("accepted_log_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    acceptedArtifactBytes: bigint("accepted_artifact_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureClassification: text("failure_classification"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_task_attempts_task_fence_unique").on(
      table.taskId,
      table.fence,
    ),
    uniqueIndex("runner_task_attempts_identity_unique").on(
      table.id,
      table.taskId,
      table.runnerId,
      table.fence,
    ),
    uniqueIndex("runner_task_attempts_one_active_per_task")
      .on(table.taskId)
      .where(
        sql`${table.status} IN ('claimed', 'preparing', 'executing', 'measuring')`,
      ),
    index("runner_task_attempts_runner_status_lease_idx").on(
      table.runnerId,
      table.status,
      table.leaseExpiresAt,
    ),
    index("runner_task_attempts_active_lease_id_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(
        sql`${table.status} IN ('claimed', 'preparing', 'executing', 'measuring')`,
      ),
    index("runner_task_attempts_task_created_idx").on(
      table.taskId,
      table.createdAt,
    ),
    positiveCheck("runner_task_attempts_fence_positive", table.fence),
    nonNegativeCheck(
      "runner_task_attempts_sequence_non_negative",
      table.lastEventSequence,
    ),
    nonNegativeCheck(
      "runner_task_attempts_log_bytes_non_negative",
      table.acceptedLogBytes,
    ),
    nonNegativeCheck(
      "runner_task_attempts_artifact_bytes_non_negative",
      table.acceptedArtifactBytes,
    ),
    check(
      "runner_task_attempts_terminal_state",
      sql`(${table.status} IN ('succeeded', 'failed', 'cancelled', 'expired')) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "runner_task_attempts_failure_classification",
      sql`(${table.status} = 'failed') = (${table.failureClassification} IS NOT NULL)`,
    ),
  ],
);

export const runnerTaskEvents = pgTable(
  "runner_task_events",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    runnerId: uuid("runner_id").notNull(),
    fence: integer("fence").notNull(),
    sequence: integer("sequence").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    envelopeDigest: text("envelope_digest").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_task_events_attempt_sequence_unique").on(
      table.attemptId,
      table.sequence,
    ),
    index("runner_task_events_task_received_id_idx").on(
      table.taskId,
      table.receivedAt,
      table.id,
    ),
    foreignKey({
      name: "runner_task_events_attempt_identity_fk",
      columns: [table.attemptId, table.taskId, table.runnerId, table.fence],
      foreignColumns: [
        runnerTaskAttempts.id,
        runnerTaskAttempts.taskId,
        runnerTaskAttempts.runnerId,
        runnerTaskAttempts.fence,
      ],
    }),
    positiveCheck("runner_task_events_fence_positive", table.fence),
    positiveCheck("runner_task_events_sequence_positive", table.sequence),
    check(
      "runner_task_events_protocol_v2",
      sql`${table.protocolVersion} = '2'`,
    ),
    check("runner_task_events_type_non_empty", sql`length(${table.type}) > 0`),
    check(
      "runner_task_events_digest_sha256",
      sql`${table.envelopeDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const artifactObjects = pgTable(
  "artifact_objects",
  {
    digest: text("digest").primaryKey(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    firstVerifiedAt: timestamp("first_verified_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    nonNegativeCheck("artifact_objects_size_non_negative", table.sizeBytes),
    check(
      "artifact_objects_digest_sha256",
      sql`${table.digest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

export const runnerTaskArtifacts = pgTable(
  "runner_task_artifacts",
  {
    id: uuid("id").primaryKey(),
    digest: text("digest")
      .notNull()
      .references(() => artifactObjects.digest),
    taskId: uuid("task_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    runnerId: uuid("runner_id").notNull(),
    fence: integer("fence").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => runnerTaskEvents.id),
    mediaType: text("media_type").notNull(),
    role: text("role").notNull(),
    retentionClass: artifactRetentionClass("retention_class")
      .default("run_evidence")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_task_artifacts_event_unique").on(table.eventId),
    index("runner_task_artifacts_task_created_id_idx").on(
      table.taskId,
      table.createdAt,
      table.id,
    ),
    index("runner_task_artifacts_digest_idx").on(table.digest),
    foreignKey({
      name: "runner_task_artifacts_attempt_identity_fk",
      columns: [table.attemptId, table.taskId, table.runnerId, table.fence],
      foreignColumns: [
        runnerTaskAttempts.id,
        runnerTaskAttempts.taskId,
        runnerTaskAttempts.runnerId,
        runnerTaskAttempts.fence,
      ],
    }),
    positiveCheck("runner_task_artifacts_fence_positive", table.fence),
    check(
      "runner_task_artifacts_media_type",
      sql`${table.mediaType} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'`,
    ),
    check(
      "runner_task_artifacts_role",
      sql`${table.role} IN ('source_snapshot', 'patch', 'measurement', 'report', 'diagnostic')`,
    ),
  ],
);

export const runnerTaskCancellations = pgTable(
  "runner_task_cancellations",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => runnerTasks.id),
    resultingTaskStatus: runnerTaskStatus("resulting_task_status").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("runner_task_cancellations_task_unique").on(table.taskId),
    check(
      "runner_task_cancellations_resulting_status",
      sql`${table.resultingTaskStatus} IN ('cancellation_requested', 'cancelled')`,
    ),
  ],
);

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => runnerTasks.id),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deliveryAttempts: integer("delivery_attempts").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("outbox_messages_unpublished_available_idx")
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.publishedAt} IS NULL`),
    nonNegativeCheck(
      "outbox_messages_delivery_attempts_non_negative",
      table.deliveryAttempts,
    ),
    check("outbox_messages_topic_non_empty", sql`length(${table.topic}) > 0`),
  ],
);
