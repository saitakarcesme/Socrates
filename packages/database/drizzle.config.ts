import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env["DATABASE_URL"] ??
      "postgresql://socrates:socrates@localhost:5432/socrates",
  },
  strict: true,
  verbose: true,
});
