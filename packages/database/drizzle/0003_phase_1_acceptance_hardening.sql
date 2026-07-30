CREATE TABLE "socrates_schema_metadata" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "socrates_schema_metadata_singleton" CHECK ("socrates_schema_metadata"."id" = 1),
	CONSTRAINT "socrates_schema_metadata_version_positive" CHECK ("socrates_schema_metadata"."version" > 0)
);
--> statement-breakpoint
INSERT INTO "socrates_schema_metadata" ("id", "version") VALUES (1, 1);
--> statement-breakpoint
CREATE INDEX "decisions_experiment_created_id_idx" ON "decisions" USING btree ("experiment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "observations_experiment_recorded_id_idx" ON "observations" USING btree ("experiment_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "learnings_project_created_id_idx" ON "learnings" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "learnings_created_id_idx" ON "learnings" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "projects_workspace_created_id_idx" ON "projects" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "experiments_run_created_id_idx" ON "experiments" USING btree ("run_id","created_at","id");--> statement-breakpoint
CREATE INDEX "runs_project_created_id_idx" ON "runs" USING btree ("project_id","created_at","id");
