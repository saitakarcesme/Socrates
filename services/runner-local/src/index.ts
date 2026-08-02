import type {
  RunnerCancellationV1,
  RunnerEventV2,
  RunnerExecutionV1,
} from "@socrates/contracts";

export interface Runner {
  readonly kind: "local" | "cloud" | "distributed";
  execute(execution: RunnerExecutionV1): AsyncIterable<RunnerEventV2>;
  cancel(command: RunnerCancellationV1): Promise<void>;
}

export class LocalRunnerNotEnabledError extends Error {
  constructor() {
    super(
      "Local execution is disabled until the Phase 2 sandbox gates are met.",
    );
  }
}

export * from "./oci/index";
export * from "./image/index";
export * from "./runtime/index";
export * from "./source/index";
export * from "./request/index";
export * from "./lifecycle/index";
export * from "./spool/index";
export * from "./transport/index";
export * from "./work-journal/index";
export * from "./supervision/index";
export * from "./execution/index";
export * from "./session/index";
export * from "./configuration/index";
export * from "./platform/index";
export * from "./deployment/index";
