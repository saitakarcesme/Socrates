CREATE TABLE "runner_registration_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"runner_id" uuid NOT NULL,
	"secret_digest" text NOT NULL,
	"label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_registration_tokens_secret_digest_sha256" CHECK ("runner_registration_tokens"."secret_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "runner_registration_tokens_label_length" CHECK (length("runner_registration_tokens"."label") BETWEEN 1 AND 80 AND "runner_registration_tokens"."label" = btrim("runner_registration_tokens"."label")),
	CONSTRAINT "runner_registration_tokens_expiry_after_creation" CHECK ("runner_registration_tokens"."expires_at" > "runner_registration_tokens"."created_at"),
	CONSTRAINT "runner_registration_tokens_revocation_after_creation" CHECK ("runner_registration_tokens"."revoked_at" IS NULL OR "runner_registration_tokens"."revoked_at" >= "runner_registration_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "runner_registration_tokens" ADD CONSTRAINT "runner_registration_tokens_runner_id_runner_registrations_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_registration_tokens_secret_digest_unique" ON "runner_registration_tokens" USING btree ("secret_digest");--> statement-breakpoint
CREATE INDEX "runner_registration_tokens_runner_active_expiry_idx" ON "runner_registration_tokens" USING btree ("runner_id","expires_at") WHERE "runner_registration_tokens"."revoked_at" IS NULL;--> statement-breakpoint
UPDATE "socrates_schema_metadata" SET "version" = 6 WHERE "id" = 1;
