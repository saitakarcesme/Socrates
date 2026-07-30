CREATE TYPE "public"."constraint_operator" AS ENUM('less_than', 'less_than_or_equal', 'greater_than', 'greater_than_or_equal');--> statement-breakpoint
CREATE TYPE "public"."decision_reason" AS ENUM('improved', 'within_noise', 'below_threshold', 'guardrail_failed', 'invalid_measurement');--> statement-breakpoint
CREATE TYPE "public"."evidence_role" AS ENUM('supports', 'contradicts');--> statement-breakpoint
CREATE TYPE "public"."experiment_decision" AS ENUM('kept', 'discarded', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('proposed', 'queued', 'executing', 'measuring', 'evaluating', 'failed', 'kept', 'discarded', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."learning_status" AS ENUM('active', 'superseded', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."metric_direction" AS ENUM('maximize', 'minimize');--> statement-breakpoint
CREATE TYPE "public"."observation_kind" AS ENUM('baseline', 'before', 'after', 'guardrail');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('draft', 'queued', 'preparing', 'running', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'budget_exhausted');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('repository', 'website', 'dataset', 'model', 'other');--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"supersedes_decision_id" uuid,
	"policy_version" text NOT NULL,
	"automated_decision" "experiment_decision" NOT NULL,
	"reason" "decision_reason" NOT NULL,
	"final_decision" "experiment_decision" NOT NULL,
	"override_reason" text,
	"calculated_improvement" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_experiment_id_unique" UNIQUE("experiment_id","id"),
	CONSTRAINT "decisions_calculated_improvement_canonical" CHECK ("decisions"."calculated_improvement" ~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND "decisions"."calculated_improvement" <> '-0'),
	CONSTRAINT "decisions_override_reason_consistent" CHECK (("decisions"."final_decision" = "decisions"."automated_decision" AND "decisions"."override_reason" IS NULL) OR ("decisions"."final_decision" <> "decisions"."automated_decision" AND "decisions"."override_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"experiment_id" uuid,
	"kind" "observation_kind" NOT NULL,
	"metric_definition_id" uuid NOT NULL,
	"amount" text NOT NULL,
	"unit" text NOT NULL,
	"sample_count" integer NOT NULL,
	"notes" text,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_amount_canonical" CHECK ("observations"."amount" ~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND "observations"."amount" <> '-0'),
	CONSTRAINT "observations_sample_count_positive" CHECK ("observations"."sample_count" > 0),
	CONSTRAINT "observations_baseline_scope" CHECK (("observations"."kind" = 'baseline' AND "observations"."experiment_id" IS NULL) OR ("observations"."kind" <> 'baseline' AND "observations"."experiment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "learning_evidence" (
	"learning_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"role" "evidence_role" NOT NULL,
	CONSTRAINT "learning_evidence_pk" PRIMARY KEY("learning_id","experiment_id")
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"confidence" real NOT NULL,
	"status" "learning_status" DEFAULT 'active' NOT NULL,
	"superseded_learning_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learnings_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "learnings_confidence_range" CHECK ("learnings"."confidence" >= 0 AND "learnings"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"command_name" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("workspace_id","key"),
	CONSTRAINT "idempotency_keys_response_complete" CHECK (("idempotency_keys"."response_status" IS NULL AND "idempotency_keys"."response_body" IS NULL AND "idempotency_keys"."completed_at" IS NULL) OR ("idempotency_keys"."response_status" BETWEEN 100 AND 599 AND "idempotency_keys"."response_body" IS NOT NULL AND "idempotency_keys"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_sequence_positive" CHECK ("run_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "constraint_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_definition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"operator" "constraint_operator" NOT NULL,
	"threshold" text NOT NULL,
	"hard" boolean NOT NULL,
	CONSTRAINT "constraint_definitions_threshold_canonical" CHECK ("constraint_definitions"."threshold" ~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND "constraint_definitions"."threshold" <> '-0')
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"direction" "metric_direction" NOT NULL,
	"minimum_improvement" text NOT NULL,
	"noise_tolerance" text NOT NULL,
	"evaluator_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_definitions_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "metric_definitions_version_positive" CHECK ("metric_definitions"."version" > 0),
	CONSTRAINT "metric_definitions_minimum_improvement_canonical" CHECK ("metric_definitions"."minimum_improvement" ~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND "metric_definitions"."minimum_improvement" <> '-0'),
	CONSTRAINT "metric_definitions_noise_tolerance_canonical" CHECK ("metric_definitions"."noise_tolerance" ~ '^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND "metric_definitions"."noise_tolerance" <> '-0'),
	CONSTRAINT "metric_definitions_minimum_improvement_non_negative" CHECK ("metric_definitions"."minimum_improvement" !~ '^-'),
	CONSTRAINT "metric_definitions_noise_tolerance_non_negative" CHECK ("metric_definitions"."noise_tolerance" !~ '^-')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"objective" text NOT NULL,
	"source_type" "source_type",
	"source_reference" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_version_non_negative" CHECK ("projects"."version" >= 0),
	CONSTRAINT "projects_source_complete" CHECK (("projects"."source_type" IS NULL) = ("projects"."source_reference" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_experiment_id" uuid,
	"sequence" integer NOT NULL,
	"hypothesis" text NOT NULL,
	"action" text NOT NULL,
	"status" "experiment_status" DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"estimated_duration_ms" bigint NOT NULL,
	"estimated_cost_minor" bigint NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_run_id_unique" UNIQUE("run_id","id"),
	CONSTRAINT "experiments_sequence_positive" CHECK ("experiments"."sequence" > 0),
	CONSTRAINT "experiments_version_non_negative" CHECK ("experiments"."version" >= 0),
	CONSTRAINT "experiments_estimated_duration_positive" CHECK ("experiments"."estimated_duration_ms" > 0),
	CONSTRAINT "experiments_estimated_cost_non_negative" CHECK ("experiments"."estimated_cost_minor" >= 0),
	CONSTRAINT "experiments_parent_not_self" CHECK ("experiments"."parent_experiment_id" IS NULL OR "experiments"."parent_experiment_id" <> "experiments"."id"),
	CONSTRAINT "experiments_completed_after_started" CHECK ("experiments"."completed_at" IS NULL OR "experiments"."started_at" IS NULL OR "experiments"."completed_at" >= "experiments"."started_at")
);
--> statement-breakpoint
CREATE TABLE "run_budgets" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"maximum_experiments" integer NOT NULL,
	"maximum_duration_ms" bigint NOT NULL,
	"maximum_cost_minor" bigint NOT NULL,
	CONSTRAINT "run_budgets_maximum_experiments_positive" CHECK ("run_budgets"."maximum_experiments" > 0),
	CONSTRAINT "run_budgets_maximum_duration_positive" CHECK ("run_budgets"."maximum_duration_ms" > 0),
	CONSTRAINT "run_budgets_maximum_cost_non_negative" CHECK ("run_budgets"."maximum_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"metric_definition_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"status" "run_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_sequence_positive" CHECK ("runs"."sequence" > 0),
	CONSTRAINT "runs_version_non_negative" CHECK ("runs"."version" >= 0),
	CONSTRAINT "runs_completed_after_started" CHECK ("runs"."completed_at" IS NULL OR "runs"."started_at" IS NULL OR "runs"."completed_at" >= "runs"."started_at")
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_superseded_same_experiment_fk" FOREIGN KEY ("experiment_id","supersedes_decision_id") REFERENCES "public"."decisions"("experiment_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_experiment_same_run_fk" FOREIGN KEY ("run_id","experiment_id") REFERENCES "public"."experiments"("run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_superseded_same_project_fk" FOREIGN KEY ("project_id","superseded_learning_id") REFERENCES "public"."learnings"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "constraint_definitions" ADD CONSTRAINT "constraints_metric_definition_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_parent_same_run_fk" FOREIGN KEY ("run_id","parent_experiment_id") REFERENCES "public"."experiments"("run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_budgets" ADD CONSTRAINT "run_budgets_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_metric_definition_project_fk" FOREIGN KEY ("project_id","metric_definition_id") REFERENCES "public"."metric_definitions"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_experiment_created_idx" ON "decisions" USING btree ("experiment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_single_root_per_experiment" ON "decisions" USING btree ("experiment_id") WHERE "decisions"."supersedes_decision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_single_successor" ON "decisions" USING btree ("supersedes_decision_id");--> statement-breakpoint
CREATE INDEX "observations_run_recorded_idx" ON "observations" USING btree ("run_id","recorded_at");--> statement-breakpoint
CREATE INDEX "observations_experiment_idx" ON "observations" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "learning_evidence_experiment_idx" ON "learning_evidence" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "learnings_project_status_idx" ON "learnings" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "learnings_single_successor" ON "learnings" USING btree ("superseded_learning_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_sequence_unique" ON "run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "run_events_run_occurred_idx" ON "run_events" USING btree ("run_id","occurred_at");--> statement-breakpoint
CREATE INDEX "constraint_definitions_metric_idx" ON "constraint_definitions" USING btree ("metric_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_definitions_project_version_unique" ON "metric_definitions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_unique" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "projects_workspace_status_idx" ON "projects" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_run_sequence_unique" ON "experiments" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "experiments_run_status_idx" ON "experiments" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_sequence_unique" ON "runs" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_id_unique" ON "runs" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "runs_project_status_idx" ON "runs" USING btree ("project_id","status");