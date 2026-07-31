CREATE UNIQUE INDEX "artifact_objects_digest_size_unique" ON "artifact_objects" USING btree ("digest","size_bytes");--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"media_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_snapshots_size_positive" CHECK ("source_snapshots"."size_bytes" > 0),
	CONSTRAINT "source_snapshots_media_type" CHECK ("source_snapshots"."media_type" = 'application/vnd.socrates.source-snapshot.v1+tar')
);
--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_artifact_identity_fk" FOREIGN KEY ("digest","size_bytes") REFERENCES "public"."artifact_objects"("digest","size_bytes") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_snapshots_digest_size_idx" ON "source_snapshots" USING btree ("digest","size_bytes");--> statement-breakpoint
UPDATE "socrates_schema_metadata" SET "version" = 10 WHERE "id" = 1;
