import { describe, expect, it, vi } from "vitest";

import { idempotencyKeyFor } from "./idempotency";

describe("command idempotency keys", () => {
  it("retains the key while retrying an unchanged payload", () => {
    const generate = vi.fn(() => "first");
    const first = idempotencyKeyFor({ name: "Atlas" }, null, generate);
    const retry = idempotencyKeyFor({ name: "Atlas" }, first, generate);

    expect(retry).toBe(first);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rotates the key after a semantic payload edit", () => {
    const generate = vi
      .fn<() => string>()
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");
    const first = idempotencyKeyFor({ name: "Atlas" }, null, generate);
    const edited = idempotencyKeyFor({ name: "Meridian" }, first, generate);

    expect(edited.key).toBe("web:second");
    expect(edited).not.toBe(first);
  });
});
