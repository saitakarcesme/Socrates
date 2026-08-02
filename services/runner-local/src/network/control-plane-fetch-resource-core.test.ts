import { describe, expect, it, vi } from "vitest";

import {
  NodeLocalRunnerControlPlaneFetchError,
  type NodeLocalRunnerControlPlaneFetchErrorCode,
} from "./control-plane-fetch-contracts";
import {
  createControlPlaneFetchResourceCore,
  type ControlPlaneFetchResourceOperations,
} from "./control-plane-fetch-resource-core";

const origin = "https://control.socrates.test";

function init(changes: Partial<RequestInit> = {}): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    signal: new AbortController().signal,
    headers: { authorization: "Bearer private-token" },
    body: "private-body",
    ...changes,
  };
}

function url(path = "/v1/runner/events"): URL {
  return new URL(path, origin);
}

function fakeOperations(
  changes: Partial<ControlPlaneFetchResourceOperations> = {},
) {
  const dispatcher = Object.freeze({ identity: "private-dispatcher" });
  const fetch = vi.fn<ControlPlaneFetchResourceOperations["fetch"]>(
    async () => new Response(null, { status: 204 }),
  );
  const close = vi.fn<ControlPlaneFetchResourceOperations["close"]>(async () =>
    Promise.resolve(),
  );
  return {
    dispatcher,
    fetch,
    close,
    operations: { dispatcher, fetch, close, ...changes },
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: NodeLocalRunnerControlPlaneFetchErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NodeLocalRunnerControlPlaneFetchError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(
    /private|control\.socrates|runner\/events|certificate|socket/u,
  );
  expect((error as Error).message).not.toMatch(
    /private|control\.socrates|runner\/events|certificate|socket/u,
  );
  return error as NodeLocalRunnerControlPlaneFetchError;
}

describe("createControlPlaneFetchResourceCore", () => {
  it("projects one detached request through only the owned dispatcher", async () => {
    const fake = fakeOperations();
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );
    const input = url();
    const callerDispatcher = Object.freeze({ identity: "caller" });

    const response = await resource.fetch(input, {
      ...init(),
      dispatcher: callerDispatcher,
    } as RequestInit);

    expect(response.status).toBe(204);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    const [projectedUrl, projectedInit] = fake.fetch.mock.calls[0]!;
    expect(projectedUrl).not.toBe(input);
    expect(projectedUrl.href).toBe(input.href);
    expect(projectedInit).toMatchObject({
      method: "POST",
      redirect: "manual",
      dispatcher: fake.dispatcher,
    });
    expect(projectedInit.dispatcher).not.toBe(callerDispatcher);
    expect(Object.isFrozen(resource)).toBe(true);
    await resource.close();
  });

  it("snapshots the URL before the asynchronous operation settles", async () => {
    let projected: URL | undefined;
    const fake = fakeOperations({
      fetch: async (input) => {
        projected = input;
        await Promise.resolve();
        return new Response(null, { status: 204 });
      },
    });
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );
    const input = url();
    const result = resource.fetch(input, init());
    input.pathname = "/private-mutation";

    await result;
    expect(projected?.pathname).toBe("/v1/runner/events");
    await resource.close();
  });

  it.each([
    "https://other.socrates.test/v1/runner/events",
    "http://control.socrates.test/v1/runner/events",
    "https://control.socrates.test/v1/projects",
    "https://control.socrates.test/v1/runner",
    "https://control.socrates.test/v1/runner/events?private=1",
    "https://control.socrates.test/v1/runner/events#private",
  ])("denies out-of-authority URL %s before dispatch", async (candidate) => {
    const fake = fakeOperations();
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );

    await expectCode(
      resource.fetch(new URL(candidate), init()),
      "invalid_request",
    );
    expect(fake.fetch).not.toHaveBeenCalled();
    await resource.close();
  });

  it.each([
    ["string input", `${origin}/v1/runner/events`, init()],
    ["Request input", new Request(`${origin}/v1/runner/events`), init()],
    ["missing init", url(), undefined],
    ["missing method", url(), init({ method: undefined })],
    ["different method", url(), init({ method: "GET" })],
    ["missing redirect", url(), init({ redirect: undefined })],
    ["follow redirect", url(), init({ redirect: "follow" })],
    ["missing signal", url(), init({ signal: undefined })],
  ] as const)(
    "denies %s before dispatch",
    async (_name, input, requestInit) => {
      const fake = fakeOperations();
      const resource = createControlPlaneFetchResourceCore(
        origin,
        fake.operations,
      );

      await expectCode(
        resource.fetch(input as RequestInfo | URL, requestInit),
        "invalid_request",
      );
      expect(fake.fetch).not.toHaveBeenCalled();
      await resource.close();
    },
  );

  it("denies proxy URL and init inputs before dispatch", async () => {
    const fake = fakeOperations();
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );

    await expectCode(
      resource.fetch(new Proxy(url(), {}), init()),
      "invalid_request",
    );
    await expectCode(
      resource.fetch(url(), new Proxy(init(), {})),
      "invalid_request",
    );
    expect(fake.fetch).not.toHaveBeenCalled();
    await resource.close();
  });

  it.each(["throw", "reject"] as const)(
    "normalizes a native fetch %s without its cause",
    async (failure) => {
      const fetch = () => {
        const error = new Error(
          "private certificate socket control.socrates.test",
        );
        if (failure === "throw") throw error;
        return Promise.reject(error);
      };
      const fake = fakeOperations({ fetch });
      const resource = createControlPlaneFetchResourceCore(
        origin,
        fake.operations,
      );

      await expectCode(resource.fetch(url(), init()), "network_failed");
      await resource.close();
    },
  );

  it("starts closing once, shares settlement, and denies later dispatch", async () => {
    let settleClose: (() => void) | undefined;
    const closeSettlement = new Promise<void>((resolve) => {
      settleClose = resolve;
    });
    const close = vi.fn(async () => closeSettlement);
    const fake = fakeOperations({ close });
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );

    const first = resource.close();
    const second = resource.close();
    expect(first).toBe(second);
    expect(close).toHaveBeenCalledTimes(1);
    await expectCode(resource.fetch(url(), init()), "closed");
    expect(fake.fetch).not.toHaveBeenCalled();
    settleClose?.();
    await first;
    expect(resource.close()).toBe(first);
  });

  it("retains one failed close settlement and never reopens", async () => {
    const close = vi.fn(async () => {
      throw new Error("private socket close failure");
    });
    const fake = fakeOperations({ close });
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );

    const first = resource.close();
    const second = resource.close();
    expect(first).toBe(second);
    await expectCode(first, "close_failed");
    await expectCode(second, "close_failed");
    expect(close).toHaveBeenCalledTimes(1);
    await expectCode(resource.fetch(url(), init()), "closed");
  });

  it("allows an accepted request to settle while close drains it", async () => {
    const events: string[] = [];
    let settleFetch: (() => void) | undefined;
    let settleClose: (() => void) | undefined;
    const fetchSettlement = new Promise<void>((resolve) => {
      settleFetch = resolve;
    });
    const closeSettlement = new Promise<void>((resolve) => {
      settleClose = resolve;
    });
    const fake = fakeOperations({
      fetch: async () => {
        events.push("fetch");
        await fetchSettlement;
        events.push("fetch-settled");
        return new Response(null, { status: 204 });
      },
      close: async () => {
        events.push("close");
        await closeSettlement;
        events.push("close-settled");
      },
    });
    const resource = createControlPlaneFetchResourceCore(
      origin,
      fake.operations,
    );

    const request = resource.fetch(url(), init());
    const closing = resource.close();
    await expectCode(resource.fetch(url(), init()), "closed");
    expect(events).toEqual(["fetch", "close"]);
    settleFetch?.();
    await request;
    settleClose?.();
    await closing;
    expect(events).toEqual([
      "fetch",
      "close",
      "fetch-settled",
      "close-settled",
    ]);
  });
});
