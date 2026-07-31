ALTER TABLE "runner_task_cancellations" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ADD COLUMN "grace_period_ms" integer;--> statement-breakpoint
UPDATE "runner_task_cancellations" SET "reason" = 'operator', "grace_period_ms" = 5000 WHERE "reason" IS NULL OR "grace_period_ms" IS NULL;--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ALTER COLUMN "grace_period_ms" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ADD CONSTRAINT "runner_task_cancellations_reason" CHECK ("runner_task_cancellations"."reason" IN ('operator', 'budget', 'policy', 'runner_shutdown'));--> statement-breakpoint
ALTER TABLE "runner_task_cancellations" ADD CONSTRAINT "runner_task_cancellations_grace_period" CHECK ("runner_task_cancellations"."grace_period_ms" BETWEEN 0 AND 60000);--> statement-breakpoint
UPDATE "socrates_schema_metadata" SET "version" = 9 WHERE "id" = 1;
