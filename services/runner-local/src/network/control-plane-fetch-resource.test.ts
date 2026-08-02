import { getGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";

import {
  NodeLocalRunnerControlPlaneFetchError,
  NodeLocalRunnerControlPlaneFetchResource,
  type NodeLocalRunnerControlPlaneFetchErrorCode,
  type NodeLocalRunnerControlPlaneFetchResourceOptions,
} from "./index";

function failure(candidate: unknown): NodeLocalRunnerControlPlaneFetchError {
  try {
    new NodeLocalRunnerControlPlaneFetchResource(
      candidate as NodeLocalRunnerControlPlaneFetchResourceOptions,
    );
  } catch (cause) {
    if (cause instanceof NodeLocalRunnerControlPlaneFetchError) return cause;
    throw cause;
  }
  throw new Error("Expected control-plane fetch construction to fail.");
}

function expectCode(
  candidate: unknown,
  code: NodeLocalRunnerControlPlaneFetchErrorCode,
) {
  const error = failure(candidate);
  expect(error.code).toBe(code);
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in error).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(/private|control\.socrates/u);
}

describe("NodeLocalRunnerControlPlaneFetchResource", () => {
  it("constructs inertly, freezes its capability, and preserves global state", async () => {
    const before = getGlobalDispatcher();
    const globalFetch = vi.spyOn(globalThis, "fetch");

    const resource = new NodeLocalRunnerControlPlaneFetchResource({
      origin: "https://control.socrates.test",
    });

    expect(globalFetch).not.toHaveBeenCalled();
    expect(getGlobalDispatcher()).toBe(before);
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Reflect.ownKeys(resource)).toEqual(["fetch"]);
    expect(typeof resource.fetch).toBe("function");
    await resource.close();
    expect(getGlobalDispatcher()).toBe(before);
    globalFetch.mockRestore();
  });

  it.each([
    undefined,
    null,
    {},
    { origin: "https://control.socrates.test", extra: true },
    { origin: "http://control.socrates.test" },
    { origin: "https://control.socrates.test/" },
    { origin: "https://control.socrates.test:443" },
    { origin: "https://user@control.socrates.test" },
    { origin: "https://control.socrates.test/path" },
    { origin: "https://control.socrates.test?private=1" },
    { origin: "https://control.socrates.test#private" },
    { origin: 1 },
  ])("rejects invalid or ambiguous origin input %#", (candidate) => {
    expectCode(candidate, "invalid_origin");
  });

  it("rejects proxy and accessor input without reading the accessor", () => {
    const read = vi.fn(() => "https://control.socrates.test");
    expectCode(
      new Proxy({ origin: "https://control.socrates.test" }, {}),
      "invalid_origin",
    );
    expectCode(
      Object.defineProperty({}, "origin", {
        enumerable: true,
        get: read,
      }),
      "invalid_origin",
    );
    expect(read).not.toHaveBeenCalled();
  });
});
