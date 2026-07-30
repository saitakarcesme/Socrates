import type { ExperimentTaskV1, RunnerEventV1 } from "@socrates/contracts";

export interface Runner {
  readonly kind: "local" | "cloud" | "distributed";
  execute(task: ExperimentTaskV1): AsyncIterable<RunnerEventV1>;
  cancel(taskId: string): Promise<void>;
}

export class LocalRunnerNotEnabledError extends Error {
  constructor() {
    super("Local execution is intentionally disabled in Phase 0.");
  }
}
