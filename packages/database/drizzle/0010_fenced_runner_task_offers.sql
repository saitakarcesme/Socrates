CREATE TABLE "runner_task_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"state" text DEFAULT 'offered' NOT NULL,
	"attempt_id" uuid,
	"fence" integer,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "runner_task_deliveries_state" CHECK ("runner_task_deliveries"."state" IN ('offered', 'claimed')),
	CONSTRAINT "runner_task_deliveries_claim_identity_complete" CHECK (("runner_task_deliveries"."state" = 'offered' AND "runner_task_deliveries"."attempt_id" IS NULL AND "runner_task_deliveries"."fence" IS NULL AND "runner_task_deliveries"."claimed_at" IS NULL) OR ("runner_task_deliveries"."state" = 'claimed' AND "runner_task_deliveries"."attempt_id" IS NOT NULL AND "runner_task_deliveries"."fence" IS NOT NULL AND "runner_task_deliveries"."claimed_at" IS NOT NULL)),
	CONSTRAINT "runner_task_deliveries_claimed_after_offer" CHECK ("runner_task_deliveries"."claimed_at" IS NULL OR "runner_task_deliveries"."claimed_at" >= "runner_task_deliveries"."offered_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runner_registrations_workspace_id_unique" ON "runner_registrations" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tasks_workspace_id_unique" ON "runner_tasks" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_task_id_runner_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."runner_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_runner_id_runner_registrations_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_task_workspace_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."runner_tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_runner_workspace_fk" FOREIGN KEY ("workspace_id","runner_id") REFERENCES "public"."runner_registrations"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_task_deliveries" ADD CONSTRAINT "runner_task_deliveries_attempt_identity_fk" FOREIGN KEY ("attempt_id","task_id","runner_id","fence") REFERENCES "public"."runner_task_attempts"("id","task_id","runner_id","fence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_task_deliveries_one_active_per_task" ON "runner_task_deliveries" USING btree ("task_id") WHERE "runner_task_deliveries"."state" IN ('offered', 'claimed');--> statement-breakpoint
CREATE INDEX "runner_task_deliveries_runner_state_offered_id_idx" ON "runner_task_deliveries" USING btree ("runner_id","state","offered_at","id");--> statement-breakpoint
UPDATE "socrates_schema_metadata" SET "version" = 7 WHERE "id" = 1;
