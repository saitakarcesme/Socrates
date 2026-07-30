CREATE TABLE "runner_task_cancellations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"resulting_task_status" "runner_task_status" NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_task_cancellations_resulting_status" CHECK ("runner_task_cancellations"."resulting_task_status" IN ('cancellation_requested', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ADD CONSTRAINT "runner_task_cancellations_task_id_runner_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."runner_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_cancellations_task_unique" ON "runner_task_cancellations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runner_task_attempts_active_lease_id_idx" ON "runner_task_attempts" USING btree ("lease_expires_at","id") WHERE "runner_task_attempts"."status" IN ('claimed', 'preparing', 'executing', 'measuring');
--> statement-breakpoint
UPDATE "socrates_schema_metadata"
SET "version" = 3
WHERE "id" = 1;
