import { Agent, fetch as undiciFetch } from "undici";

import {
  admitControlPlaneFetchOrigin,
  NodeLocalRunnerControlPlaneFetchError,
} from "./control-plane-fetch-contracts";
import {
  createControlPlaneFetchResourceCore,
  type ControlPlaneFetchOperation,
} from "./control-plane-fetch-resource-core";

export type NodeLocalRunnerControlPlaneFetchResourceOptions = Readonly<{
  origin: unknown;
}>;

const directAgentOptions = Object.freeze({
  allowH2: false,
  autoSelectFamily: true,
  connections: 4,
  maxRedirections: 0,
  pipelining: 1,
  connect: Object.freeze({
    minVersion: "TLSv1.2" as const,
    rejectUnauthorized: true,
  }),
});

const productionFetch = undiciFetch as unknown as ControlPlaneFetchOperation;

export class NodeLocalRunnerControlPlaneFetchResource {
  readonly fetch: typeof globalThis.fetch;
  readonly #close: () => Promise<void>;

  constructor(options: NodeLocalRunnerControlPlaneFetchResourceOptions) {
    const origin = admitControlPlaneFetchOrigin(options);
    const agent = new Agent(directAgentOptions);
    const resource = createControlPlaneFetchResourceCore(origin, {
      dispatcher: agent,
      fetch: productionFetch,
      close: () => agent.close(),
    });
    this.fetch = resource.fetch;
    this.#close = resource.close;
    Object.freeze(this);
  }

  close(): Promise<void> {
    return this.#close();
  }
}

export { NodeLocalRunnerControlPlaneFetchError };
export type { NodeLocalRunnerControlPlaneFetchErrorCode } from "./control-plane-fetch-contracts";
