import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { DecimalAmount } from "./decimal";

function canonicalDecimal(coefficient: number, scale: number): string {
  if (coefficient === 0) {
    return "0";
  }

  const negative = coefficient < 0;
  const digits = Math.abs(coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const unsigned =
    scale === 0
      ? digits
      : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
          .replace(/0+$/, "")
          .replace(/\.$/, "");

  return negative ? `-${unsigned}` : unsigned;
}

const decimalParts = fc.record({
  coefficient: fc.integer({ min: -1_000_000, max: 1_000_000 }),
  scale: fc.integer({ min: 0, max: 6 }),
});

describe("DecimalAmount properties", () => {
  it("round-trips every generated canonical decimal", () => {
    fc.assert(
      fc.property(decimalParts, ({ coefficient, scale }) => {
        const value = canonicalDecimal(coefficient, scale);

        expect(DecimalAmount.parse(value).toString()).toBe(value);
      }),
      { numRuns: 500 },
    );
  });

  it("subtracts same-scale values exactly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 6 }),
        (leftCoefficient, rightCoefficient, scale) => {
          const left = DecimalAmount.parse(
            canonicalDecimal(leftCoefficient, scale),
          );
          const right = DecimalAmount.parse(
            canonicalDecimal(rightCoefficient, scale),
          );

          expect(left.subtract(right).toString()).toBe(
            canonicalDecimal(leftCoefficient - rightCoefficient, scale),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps comparison antisymmetric", () => {
    fc.assert(
      fc.property(decimalParts, decimalParts, (leftParts, rightParts) => {
        const left = DecimalAmount.parse(
          canonicalDecimal(leftParts.coefficient, leftParts.scale),
        );
        const right = DecimalAmount.parse(
          canonicalDecimal(rightParts.coefficient, rightParts.scale),
        );

        const comparison = left.compare(right);
        const reverse = right.compare(left);
        expect(comparison).toBe(reverse === 0 ? 0 : -reverse);
      }),
      { numRuns: 500 },
    );
  });
});
