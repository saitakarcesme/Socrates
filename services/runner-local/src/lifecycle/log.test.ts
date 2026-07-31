import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RuntimeLogBudgetError, runtimeLogDrafts } from "./log";

describe("runtime log drafts", () => {
  it("decodes split code points and redacts secrets across runtime chunks", () => {
    const bytes = new TextEncoder().encode(
      "prefix € Authorization: Bearer abcdefghijklmnop suffix",
    );
    const result = runtimeLogDrafts({
      stream: "stdout",
      chunks: [bytes.subarray(0, 8), bytes.subarray(8, 29), bytes.subarray(29)],
      remainingBudgetBytes: 1_024,
    });

    expect(result.drafts).toEqual([
      {
        type: "log.appended",
        payload: {
          stream: "stdout",
          text: "prefix € Authorization: Bearer [REDACTED] suffix",
          utf8Bytes: 50,
          redacted: true,
        },
      },
    ]);
  });

  it("renders invalid UTF-8 deterministically and marks it redacted", () => {
    const result = runtimeLogDrafts({
      stream: "stderr",
      chunks: [Uint8Array.from([0x66, 0x80, 0x6f])],
      remainingBudgetBytes: 32,
    });

    expect(result.drafts).toEqual([
      {
        type: "log.appended",
        payload: {
          stream: "stderr",
          text: "f�o",
          utf8Bytes: 5,
          redacted: true,
        },
      },
    ]);
  });

  it("chunks by code point within the V2 character limit", () => {
    const text = "😀".repeat(8_193);
    const result = runtimeLogDrafts({
      stream: "stdout",
      chunks: [new TextEncoder().encode(text)],
      remainingBudgetBytes: 40_000,
    });

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]?.payload).toMatchObject({
      utf8Bytes: 32_768,
      redacted: false,
    });
    expect(result.drafts[1]?.payload).toMatchObject({
      utf8Bytes: 4,
      redacted: false,
    });
  });

  it("fails atomically when transformed logs exceed the remaining budget", () => {
    expect(() =>
      runtimeLogDrafts({
        stream: "stdout",
        chunks: [new TextEncoder().encode("too large")],
        remainingBudgetBytes: 3,
      }),
    ).toThrow(RuntimeLogBudgetError);
  });

  it("preserves safe Unicode while keeping every draft within contract limits", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "Z", " ", "\n", "€", "😀"), {
          maxLength: 20_000,
        }),
        (characters) => {
          const text = characters.join("");
          const result = runtimeLogDrafts({
            stream: "stdout",
            chunks: [new TextEncoder().encode(text)],
            remainingBudgetBytes: 100_000,
          });
          const logs = result.drafts.filter(
            (draft) => draft.type === "log.appended",
          );
          expect(logs.map((draft) => draft.payload.text).join("")).toBe(text);
          for (const draft of logs) {
            expect(draft.payload.text.length).toBeLessThanOrEqual(16_384);
            expect(draft.payload.utf8Bytes).toBeLessThanOrEqual(65_536);
            expect(
              new TextEncoder().encode(draft.payload.text).byteLength,
            ).toBe(draft.payload.utf8Bytes);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
