import { describe, expect, it, vi } from "vitest";

import { captureSandboxProbeIdentitySource } from "./probe-identity";

const identity = Object.freeze({
  taskId: "20000000-0000-4000-8000-000000000002",
  attemptId: "30000000-0000-4000-8000-000000000003",
});

describe("sandbox probe identity source", () => {
  it("captures one method and returns a detached frozen identity", () => {
    const next = vi.fn(() => ({ ...identity }));
    const source = { next };
    const captured = captureSandboxProbeIdentitySource(source);
    source.next = () => {
      throw new Error("mutated");
    };

    const value = captured.next();
    expect(value).toEqual(identity);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["primitive", 1],
    ["missing", {}],
    ["non-callable", { next: true }],
  ])("rejects an invalid source owner: %s", (_name, source) => {
    expect(() =>
      captureSandboxProbeIdentitySource(
        source as unknown as { next(): typeof identity },
      ),
    ).toThrow("Probe identity source is invalid");
  });

  it("normalizes a throwing method getter without invoking a source method", () => {
    const source = Object.defineProperty({}, "next", {
      get: () => {
        throw new Error("private getter value");
      },
    });
    expect(() =>
      captureSandboxProbeIdentitySource(source as { next(): typeof identity }),
    ).toThrow("Probe identity source is invalid");
  });

  it.each([
    null,
    {},
    { ...identity, extra: true },
    { ...identity, taskId: "not-a-uuid" },
    { ...identity, attemptId: "not-a-uuid" },
  ])("rejects an invalid emitted identity %#", (value) => {
    const captured = captureSandboxProbeIdentitySource({
      next: () => value as typeof identity,
    });
    expect(() => captured.next()).toThrow(
      "Probe identity source returned an invalid value",
    );
  });
});
