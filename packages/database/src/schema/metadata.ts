import { sql } from "drizzle-orm";
import { check, integer, pgTable } from "drizzle-orm/pg-core";

export const schemaMetadata = pgTable(
  "socrates_schema_metadata",
  {
    id: integer("id").primaryKey(),
    version: integer("version").notNull(),
  },
  (table) => [
    check("socrates_schema_metadata_singleton", sql`${table.id} = 1`),
    check(
      "socrates_schema_metadata_version_positive",
      sql`${table.version} > 0`,
    ),
  ],
);
