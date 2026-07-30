import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor";

describe("opaque keyset cursor", () => {
  const cursor = {
    createdAt: new Date("2026-01-04T08:20:00.000Z"),
    id: "019c1170-8b7a-7a60-b7f8-f35c85d75006",
  };

  it("round-trips a versioned cursor", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("treats an absent cursor as the first page", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it.each(["***", "e30", Buffer.from('{"version":2}').toString("base64url")])(
    "rejects invalid cursor %s",
    (value) => {
      expect(() => decodeCursor(value)).toThrow(InvalidCursorError);
    },
  );
});
