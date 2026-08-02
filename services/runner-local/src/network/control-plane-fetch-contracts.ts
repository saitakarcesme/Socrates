import { types } from "node:util";

export type NodeLocalRunnerControlPlaneFetchErrorCode =
  | "invalid_origin"
  | "invalid_request"
  | "network_failed"
  | "closed"
  | "close_failed";

export class NodeLocalRunnerControlPlaneFetchError extends Error {
  constructor(readonly code: NodeLocalRunnerControlPlaneFetchErrorCode) {
    super("Local runner control-plane network operation failed.");
    this.name = "NodeLocalRunnerControlPlaneFetchError";
    Object.freeze(this);
  }
}

export function controlPlaneFetchFailure(
  code: NodeLocalRunnerControlPlaneFetchErrorCode,
): never {
  throw new NodeLocalRunnerControlPlaneFetchError(code);
}

function dataValue(candidate: object, key: "origin"): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return controlPlaneFetchFailure("invalid_origin");
  }
  return descriptor.value;
}

export function admitControlPlaneFetchOrigin(candidate: unknown): string {
  let owner: object;
  let keys: readonly PropertyKey[];
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      types.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      return controlPlaneFetchFailure("invalid_origin");
    }
    owner = candidate;
    keys = Reflect.ownKeys(owner);
  } catch {
    return controlPlaneFetchFailure("invalid_origin");
  }

  if (keys.length !== 1 || keys[0] !== "origin") {
    return controlPlaneFetchFailure("invalid_origin");
  }

  let origin: unknown;
  try {
    origin = dataValue(owner, "origin");
  } catch {
    return controlPlaneFetchFailure("invalid_origin");
  }
  if (typeof origin !== "string" || origin.length > 2_048) {
    return controlPlaneFetchFailure("invalid_origin");
  }

  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      origin !== url.origin
    ) {
      return controlPlaneFetchFailure("invalid_origin");
    }
  } catch {
    return controlPlaneFetchFailure("invalid_origin");
  }

  return origin;
}
