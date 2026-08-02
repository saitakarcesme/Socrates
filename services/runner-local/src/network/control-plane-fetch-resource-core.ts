import { types } from "node:util";

import { controlPlaneFetchFailure } from "./control-plane-fetch-contracts";

export type ControlPlaneFetchOperation = (
  input: URL,
  init: RequestInit & Readonly<{ dispatcher: unknown }>,
) => Promise<Response>;

export type ControlPlaneFetchResourceOperations = Readonly<{
  dispatcher: unknown;
  fetch: ControlPlaneFetchOperation;
  close(): Promise<void>;
}>;

export type ControlPlaneFetchResourceCore = Readonly<{
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}>;

function requestUrl(input: RequestInfo | URL, origin: string): URL {
  let candidate: URL;
  try {
    if (
      !(input instanceof URL) ||
      types.isProxy(input) ||
      Object.getPrototypeOf(input) !== URL.prototype
    ) {
      return controlPlaneFetchFailure("invalid_request");
    }
    candidate = new URL(URL.prototype.toString.call(input));
  } catch {
    return controlPlaneFetchFailure("invalid_request");
  }

  if (
    candidate.origin !== origin ||
    candidate.protocol !== "https:" ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    !candidate.pathname.startsWith("/v1/runner/") ||
    candidate.search !== "" ||
    candidate.hash !== ""
  ) {
    return controlPlaneFetchFailure("invalid_request");
  }
  return candidate;
}

function requestInit(init: RequestInit | undefined): RequestInit {
  try {
    if (
      typeof init !== "object" ||
      init === null ||
      types.isProxy(init) ||
      init.method !== "POST" ||
      init.redirect !== "manual" ||
      !(init.signal instanceof AbortSignal) ||
      types.isProxy(init.signal)
    ) {
      return controlPlaneFetchFailure("invalid_request");
    }
    return { ...init };
  } catch {
    return controlPlaneFetchFailure("invalid_request");
  }
}

export function createControlPlaneFetchResourceCore(
  origin: string,
  operations: ControlPlaneFetchResourceOperations,
): ControlPlaneFetchResourceCore {
  let state: "open" | "closing" | "closed" = "open";
  let closeSettlement: Promise<void> | undefined;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (state !== "open") return controlPlaneFetchFailure("closed");
    const url = requestUrl(input, origin);
    const admittedInit = requestInit(init);
    try {
      return await operations.fetch(url, {
        ...admittedInit,
        dispatcher: operations.dispatcher,
      });
    } catch {
      return controlPlaneFetchFailure("network_failed");
    }
  };

  const close = (): Promise<void> => {
    if (closeSettlement !== undefined) return closeSettlement;
    state = "closing";
    closeSettlement = (async () => {
      try {
        await operations.close();
      } catch {
        state = "closed";
        return controlPlaneFetchFailure("close_failed");
      }
      state = "closed";
    })();
    return closeSettlement;
  };

  return Object.freeze({ fetch, close });
}
