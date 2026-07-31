import { describe, expect, it } from "vitest";

import { redactEvidenceText } from "./index";

describe("evidence text redaction", () => {
  it("redacts credential shapes across multiline input", () => {
    expect(
      redactEvidenceText(
        "Authorization: Bearer abcdefghijklmnop\napi_key=sk-secretvalue123\nAKIAABCDEFGHIJKLMNOP",
      ),
    ).toEqual({
      text: [
        "Authorization: Bearer [REDACTED]",
        "api_key=[REDACTED]",
        "[REDACTED]",
      ].join("\n"),
      matched: true,
    });
  });

  it("preserves inert text when no credential pattern matches", () => {
    expect(redactEvidenceText(`<script>alert("text")</script>`)).toEqual({
      text: `<script>alert("text")</script>`,
      matched: false,
    });
  });
});
