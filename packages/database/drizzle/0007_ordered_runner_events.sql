CREATE TABLE "runner_task_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"fence" integer NOT NULL,
	"sequence" integer NOT NULL,
	"protocol_version" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"envelope_digest" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_task_events_fence_positive" CHECK ("runner_task_events"."fence" > 0),
	CONSTRAINT "runner_task_events_sequence_positive" CHECK ("runner_task_events"."sequence" > 0),
	CONSTRAINT "runner_task_events_protocol_v2" CHECK ("runner_task_events"."protocol_version" = '2'),
	CONSTRAINT "runner_task_events_type_non_empty" CHECK (length("runner_task_events"."type") > 0),
	CONSTRAINT "runner_task_events_digest_sha256" CHECK ("runner_task_events"."envelope_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_attempts_identity_unique" ON "runner_task_attempts" USING btree ("id","task_id","runner_id","fence");--> statement-breakpoint
ALTER TABLE "runner_task_events" ADD CONSTRAINT "runner_task_events_attempt_identity_fk" FOREIGN KEY ("attempt_id","task_id","runner_id","fence") REFERENCES "public"."runner_task_attempts"("id","task_id","runner_id","fence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_events_attempt_sequence_unique" ON "runner_task_events" USING btree ("attempt_id","sequence");--> statement-breakpoint
CREATE INDEX "runner_task_events_task_received_id_idx" ON "runner_task_events" USING btree ("task_id","received_at","id");--> statement-breakpoint
UPDATE "socrates_schema_metadata"
SET "version" = 4
WHERE "id" = 1;
