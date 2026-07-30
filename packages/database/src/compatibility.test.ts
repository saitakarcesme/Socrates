import { describe, expect, it } from "vitest";

import {
  assertDatabaseCompatibility,
  assertSupportedSchemaVersion,
  DatabaseCompatibilityError,
  supportedSchemaVersion,
} from "./compatibility";

describe("database schema compatibility", () => {
  it("accepts only the exact supported version", () => {
    expect(() =>
      assertSupportedSchemaVersion(supportedSchemaVersion),
    ).not.toThrow();
    expect(() =>
      assertSupportedSchemaVersion(supportedSchemaVersion + 1),
    ).toThrowError(DatabaseCompatibilityError);
  });

  it.runIf(Boolean(process.env["DATABASE_URL"]))(
    "reads compatibility metadata from a migrated database",
    async () => {
      await expect(
        assertDatabaseCompatibility(process.env["DATABASE_URL"]!),
      ).resolves.toBeUndefined();
    },
  );
});
