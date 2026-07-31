CREATE TYPE "public"."artifact_retention_class" AS ENUM('run_evidence');--> statement-breakpoint
CREATE TABLE "artifact_objects" (
	"digest" text PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"first_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_objects_size_non_negative" CHECK ("artifact_objects"."size_bytes" >= 0),
	CONSTRAINT "artifact_objects_digest_sha256" CHECK ("artifact_objects"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "runner_task_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"media_type" text NOT NULL,
	"role" text NOT NULL,
	"retention_class" "artifact_retention_class" DEFAULT 'run_evidence' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_task_artifacts_fence_positive" CHECK ("runner_task_artifacts"."fence" > 0),
	CONSTRAINT "runner_task_artifacts_media_type" CHECK ("runner_task_artifacts"."media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
	CONSTRAINT "runner_task_artifacts_role" CHECK ("runner_task_artifacts"."role" IN ('source_snapshot', 'patch', 'measurement', 'report', 'diagnostic'))
);
--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD COLUMN "accepted_log_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD COLUMN "accepted_artifact_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_task_artifacts" ADD CONSTRAINT "runner_task_artifacts_digest_artifact_objects_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."artifact_objects"("digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_artifacts" ADD CONSTRAINT "runner_task_artifacts_event_id_runner_task_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."runner_task_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_artifacts" ADD CONSTRAINT "runner_task_artifacts_attempt_identity_fk" FOREIGN KEY ("attempt_id","task_id","runner_id","fence") REFERENCES "public"."runner_task_attempts"("id","task_id","runner_id","fence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_artifacts_event_unique" ON "runner_task_artifacts" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "runner_task_artifacts_task_created_id_idx" ON "runner_task_artifacts" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "runner_task_artifacts_digest_idx" ON "runner_task_artifacts" USING btree ("digest");--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD CONSTRAINT "runner_task_attempts_log_bytes_non_negative" CHECK ("runner_task_attempts"."accepted_log_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "runner_task_attempts" ADD CONSTRAINT "runner_task_attempts_artifact_bytes_non_negative" CHECK ("runner_task_attempts"."accepted_artifact_bytes" >= 0);--> statement-breakpoint
UPDATE "socrates_schema_metadata"
SET "version" = 5
WHERE "id" = 1;
