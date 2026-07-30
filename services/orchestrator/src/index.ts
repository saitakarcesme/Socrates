export type ResearchStrategy = {
  name: string;
  proposeNextExperiment(runId: string): Promise<unknown>;
};

export class OrchestratorUnavailableError extends Error {
  constructor() {
    super("The research orchestrator is not enabled in the product skeleton.");
  }
}
