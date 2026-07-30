import { describe, expect, it } from "vitest";

import { DecimalAmount } from "./decimal";

describe("DecimalAmount", () => {
  it.each(["0", "12", "-4", "0.01", "-19.375"])(
    "round-trips canonical value %s",
    (value) => {
      expect(DecimalAmount.parse(value).toString()).toBe(value);
    },
  );

  it.each(["-0", "01", "1.0", "1.", ".5", "+1", "1e3"])(
    "rejects non-canonical value %s",
    (value) => {
      expect(() => DecimalAmount.parse(value)).toThrow(
        "Invalid canonical decimal",
      );
    },
  );

  it("aligns different scales for exact subtraction", () => {
    expect(
      DecimalAmount.parse("1.2")
        .subtract(DecimalAmount.parse("0.03"))
        .toString(),
    ).toBe("1.17");
  });

  it("normalizes subtraction results without negative zero", () => {
    expect(
      DecimalAmount.parse("2.5")
        .subtract(DecimalAmount.parse("2.5"))
        .toString(),
    ).toBe("0");
  });

  it("compares values without floating-point conversion", () => {
    expect(
      DecimalAmount.parse("9007199254740993.01").compare(
        DecimalAmount.parse("9007199254740993"),
      ),
    ).toBe(1);
  });
});
