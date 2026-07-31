import postgres from "postgres";

export const supportedSchemaVersion = 8;

export class DatabaseCompatibilityError extends Error {
  constructor(
    readonly code: "metadata_unavailable" | "unsupported_version",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseCompatibilityError";
  }
}

export function assertSupportedSchemaVersion(actual: number): void {
  if (actual !== supportedSchemaVersion) {
    throw new DatabaseCompatibilityError(
      "unsupported_version",
      `Database schema version ${actual} is incompatible; expected ${supportedSchemaVersion}.`,
    );
  }
}

export async function assertDatabaseCompatibility(
  connectionString: string,
): Promise<void> {
  const client = postgres(connectionString, { max: 1 });

  try {
    const [metadata] = await client<
      readonly { version: number }[]
    >`select version from socrates_schema_metadata where id = 1`;

    if (!metadata) {
      throw new DatabaseCompatibilityError(
        "metadata_unavailable",
        "Database schema compatibility metadata is missing.",
      );
    }
    assertSupportedSchemaVersion(metadata.version);
  } catch (error) {
    if (error instanceof DatabaseCompatibilityError) throw error;
    throw new DatabaseCompatibilityError(
      "metadata_unavailable",
      "Database schema compatibility metadata is unavailable.",
    );
  } finally {
    await client.end();
  }
}
