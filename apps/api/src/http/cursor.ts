import { entityIdSchema } from "@socrates/contracts";
import type { CreatedCursor } from "@socrates/database";

type CursorPayload = {
  version: 1;
  createdAt: string;
  id: string;
};

export class InvalidCursorError extends Error {
  constructor() {
    super("The supplied cursor is invalid.");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(cursor: CreatedCursor): string {
  const payload: CursorPayload = {
    version: 1,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(value: string | undefined): CreatedCursor | null {
  if (!value) {
    return null;
  }

  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new InvalidCursorError();
    }

    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    const createdAt = new Date(payload.createdAt ?? "");

    if (
      payload.version !== 1 ||
      !Number.isFinite(createdAt.getTime()) ||
      !entityIdSchema.safeParse(payload.id).success
    ) {
      throw new InvalidCursorError();
    }

    return {
      createdAt,
      id: payload.id as string,
    };
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error;
    }

    throw new InvalidCursorError();
  }
}
