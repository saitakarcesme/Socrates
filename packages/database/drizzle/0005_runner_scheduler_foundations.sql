CREATE TYPE "public"."runner_attempt_status" AS ENUM('claimed', 'preparing', 'executing', 'measuring', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."runner_kind" AS ENUM('local', 'cloud', 'distributed');--> statement-breakpoint
CREATE TYPE "public"."runner_registration_status" AS ENUM('active', 'draining', 'offline');--> statement-breakpoint
CREATE TYPE "public"."runner_task_status" AS ENUM('queued', 'leased', 'running', 'cancellation_requested', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_delivery_attempts_non_negative" CHECK ("outbox_messages"."delivery_attempts" >= 0),
	CONSTRAINT "outbox_messages_topic_non_empty" CHECK (length("outbox_messages"."topic") > 0)
);
--> statement-breakpoint
CREATE TABLE "runner_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "runner_kind" NOT NULL,
	"status" "runner_registration_status" DEFAULT 'active' NOT NULL,
	"software_version" text NOT NULL,
	"task_protocol_versions" text[] NOT NULL,
	"event_protocol_versions" text[] NOT NULL,
	"sandbox_backend" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"maximum_concurrent_tasks" integer NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_registrations_capacity_positive" CHECK ("runner_registrations"."maximum_concurrent_tasks" > 0),
	CONSTRAINT "runner_registrations_task_protocol_v2" CHECK ('2' = ANY("runner_registrations"."task_protocol_versions")),
	CONSTRAINT "runner_registrations_event_protocol_v2" CHECK ('2' = ANY("runner_registrations"."event_protocol_versions")),
	CONSTRAINT "runner_registrations_oci_backend" CHECK ("runner_registrations"."sandbox_backend" = 'oci')
);
--> statement-breakpoint
CREATE TABLE "runner_task_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"status" "runner_attempt_status" DEFAULT 'claimed' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_sequence" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_task_attempts_fence_positive" CHECK ("runner_task_attempts"."fence" > 0),
	CONSTRAINT "runner_task_attempts_sequence_non_negative" CHECK ("runner_task_attempts"."last_event_sequence" >= 0),
	CONSTRAINT "runner_task_attempts_terminal_state" CHECK (("runner_task_attempts"."status" IN ('succeeded', 'failed', 'cancelled', 'expired')) = ("runner_task_attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "runner_task_attempts_failure_classification" CHECK (("runner_task_attempts"."status" = 'failed') = ("runner_task_attempts"."failure_classification" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "runner_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"protocol_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"required_capabilities" jsonb NOT NULL,
	"status" "runner_task_status" DEFAULT 'queued' NOT NULL,
	"retry_safe" boolean NOT NULL,
	"current_fence" integer DEFAULT 0 NOT NULL,
	"cancellation_requested_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_tasks_current_fence_non_negative" CHECK ("runner_tasks"."current_fence" >= 0),
	CONSTRAINT "runner_tasks_protocol_v2" CHECK ("runner_tasks"."protocol_version" = '2'),
	CONSTRAINT "runner_tasks_terminal_state" CHECK (("runner_tasks"."status" IN ('succeeded', 'failed', 'cancelled')) = ("runner_tasks"."terminal_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_task_id_runner_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."runner_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registrations" ADD CONSTRAINT "runner_registrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD CONSTRAINT "runner_task_attempts_task_id_runner_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."runner_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD CONSTRAINT "runner_task_attempts_runner_id_runner_registrations_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_project_same_workspace_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_run_same_project_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."runs"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tasks" ADD CONSTRAINT "runner_tasks_experiment_same_run_fk" FOREIGN KEY ("run_id","experiment_id") REFERENCES "public"."experiments"("run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_messages_unpublished_available_idx" ON "outbox_messages" USING btree ("available_at","created_at","id") WHERE "outbox_messages"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "runner_registrations_workspace_status_heartbeat_idx" ON "runner_registrations" USING btree ("workspace_id","status","last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_attempts_task_fence_unique" ON "runner_task_attempts" USING btree ("task_id","fence");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_attempts_one_active_per_task" ON "runner_task_attempts" USING btree ("task_id") WHERE "runner_task_attempts"."status" IN ('claimed', 'preparing', 'executing', 'measuring');--> statement-breakpoint
CREATE INDEX "runner_task_attempts_runner_status_lease_idx" ON "runner_task_attempts" USING btree ("runner_id","status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "runner_task_attempts_task_created_idx" ON "runner_task_attempts" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tasks_experiment_unique" ON "runner_tasks" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "runner_tasks_workspace_queue_created_id_idx" ON "runner_tasks" USING btree ("workspace_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "runner_tasks_run_created_id_idx" ON "runner_tasks" USING btree ("run_id","created_at","id");--> statement-breakpoint
UPDATE "socrates_schema_metadata" SET "version" = 2 WHERE "id" = 1;
