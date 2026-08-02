import { describe, expect, it, vi } from "vitest";

import { assertPlainDataStructure, deepFreezePlainData } from "./plain-data";

function nested(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

describe("plain data structure admission", () => {
  it("preserves ADR-086 object-only admission", () => {
    expect(() =>
      assertPlainDataStructure(
        { version: "1", nested: { value: 1 } },
        { arrays: "reject" },
      ),
    ).not.toThrow();
    expect(() =>
      assertPlainDataStructure({ value: [] }, { arrays: "reject" }),
    ).toThrow("arrays are not admitted");
  });

  it("accepts only dense ordinary arrays in array mode", () => {
    expect(() =>
      assertPlainDataStructure(
        Object.freeze({ values: Object.freeze([1, "two", null]) }),
        { arrays: "allow" },
      ),
    ).not.toThrow();

    const sparse = new Array(2);
    sparse[1] = true;
    expect(() => assertPlainDataStructure(sparse, { arrays: "allow" })).toThrow(
      "dense data arrays",
    );

    const extended = [true] as boolean[] & { extra?: boolean };
    extended.extra = true;
    expect(() =>
      assertPlainDataStructure(extended, { arrays: "allow" }),
    ).toThrow("extension keys");

    const custom = [true];
    Object.setPrototypeOf(custom, { custom: true });
    expect(() => assertPlainDataStructure(custom, { arrays: "allow" })).toThrow(
      "arrays are not admitted",
    );
  });

  it("never invokes accessor values", () => {
    const read = vi.fn(() => "private");
    const candidate = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: read,
    });

    expect(() =>
      assertPlainDataStructure(candidate, { arrays: "allow" }),
    ).toThrow("properties must contain data");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects symbols, custom prototypes, functions, and cycles", () => {
    expect(() =>
      assertPlainDataStructure(
        { [Symbol("private")]: true },
        { arrays: "allow" },
      ),
    ).toThrow("symbol keys");
    expect(() =>
      assertPlainDataStructure(new Date(0), { arrays: "allow" }),
    ).toThrow("plain prototypes");
    expect(() =>
      assertPlainDataStructure({ value: () => true }, { arrays: "allow" }),
    ).toThrow("only plain data");

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertPlainDataStructure(cyclic, { arrays: "allow" })).toThrow(
      "cycles",
    );
  });

  it("enforces exact container-depth and visited-node edges", () => {
    expect(() =>
      assertPlainDataStructure(nested(32), {
        arrays: "allow",
        maximumDepth: 32,
        maximumNodes: 33,
      }),
    ).not.toThrow();
    expect(() =>
      assertPlainDataStructure(nested(33), {
        arrays: "allow",
        maximumDepth: 32,
        maximumNodes: 34,
      }),
    ).toThrow("nested too deeply");
    expect(() =>
      assertPlainDataStructure([1, 2, 3], {
        arrays: "allow",
        maximumNodes: 4,
      }),
    ).not.toThrow();
    expect(() =>
      assertPlainDataStructure([1, 2, 3, 4], {
        arrays: "allow",
        maximumNodes: 4,
      }),
    ).toThrow("too many nodes");
  });

  it("deeply freezes object and array data without replacing identity", () => {
    const value = { nested: [{ accepted: true }] };
    const frozen = deepFreezePlainData(value);

    expect(frozen).toBe(value);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.nested[0])).toBe(true);
  });
});
