import {
  apiErrorSchema,
  type CreateLearningCommand,
  type CreateMetricDefinitionCommand,
  type CreateProjectCommand,
  type CreateRunCommand,
  type DecideExperimentCommand,
  experimentListResponseSchema,
  type ExperimentLifecycleCommand,
  experimentMutationResponseSchema,
  experimentResponseSchema,
  learningListResponseSchema,
  learningMutationResponseSchema,
  observationMutationResponseSchema,
  type ProposeExperimentCommand,
  projectListResponseSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  type RecordBaselineCommand,
  type RecordObservationCommand,
  runEventListResponseSchema,
  runListResponseSchema,
  type RunLifecycleCommand,
  runMutationResponseSchema,
  runResponseSchema,
} from "@socrates/contracts";

type ResponseParser<T> = {
  parse(input: unknown): T;
};

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export class ControlPlaneContractError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(
      `The control plane returned an invalid response for ${path}.`,
      options,
    );
    this.name = "ControlPlaneContractError";
  }
}

export type ControlPlaneClientOptions = {
  baseUrl: string;
  fetcher?: typeof fetch;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new ControlPlaneContractError(response.url || "unknown", { cause });
  }
}

export function createControlPlaneClient(options: ControlPlaneClientOptions) {
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    path: string,
    parser: ResponseParser<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetcher(joinUrl(options.baseUrl, path), {
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
    const body = await readJson(response);

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      if (parsed.success) {
        throw new ControlPlaneError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.requestId,
          parsed.data.error.details,
        );
      }

      throw new ControlPlaneError(
        response.status,
        "invalid_error_response",
        "The control plane request failed.",
        response.headers.get("x-request-id"),
      );
    }

    try {
      return parser.parse(body);
    } catch (cause) {
      throw new ControlPlaneContractError(path, { cause });
    }
  }

  function command<TBody, TResponse>(
    path: string,
    body: TBody,
    idempotencyKey: string,
    parser: ResponseParser<TResponse>,
  ) {
    return request(path, parser, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  }

  return {
    listProjects: (cursor?: string) =>
      request(
        `/v1/projects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        projectListResponseSchema,
      ),
    getProject: (projectId: string) =>
      request(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        projectResponseSchema,
      ),
    listRuns: (projectId: string, cursor?: string) =>
      request(
        `/v1/projects/${encodeURIComponent(projectId)}/runs?limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
        runListResponseSchema,
      ),
    getRun: (runId: string) =>
      request(`/v1/runs/${encodeURIComponent(runId)}`, runResponseSchema),
    listExperiments: (runId: string, cursor?: string) =>
      request(
        `/v1/runs/${encodeURIComponent(runId)}/experiments?limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
        experimentListResponseSchema,
      ),
    getExperiment: (experimentId: string) =>
      request(
        `/v1/experiments/${encodeURIComponent(experimentId)}`,
        experimentResponseSchema,
      ),
    listLearnings: (projectId: string, cursor?: string) =>
      request(
        `/v1/projects/${encodeURIComponent(projectId)}/learnings?limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
        learningListResponseSchema,
      ),
    listRunEvents: (runId: string, after = 0) =>
      request(
        `/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=500`,
        runEventListResponseSchema,
      ),
    createProject: (body: CreateProjectCommand, idempotencyKey: string) =>
      command(
        "/v1/projects",
        body,
        idempotencyKey,
        projectMutationResponseSchema,
      ),
    addMetricDefinition: (
      projectId: string,
      body: CreateMetricDefinitionCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/projects/${encodeURIComponent(projectId)}/metric-definitions`,
        body,
        idempotencyKey,
        projectMutationResponseSchema,
      ),
    createRun: (
      projectId: string,
      body: CreateRunCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/projects/${encodeURIComponent(projectId)}/runs`,
        body,
        idempotencyKey,
        runMutationResponseSchema,
      ),
    recordBaseline: (
      runId: string,
      body: RecordBaselineCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/runs/${encodeURIComponent(runId)}/baseline`,
        body,
        idempotencyKey,
        runMutationResponseSchema,
      ),
    startRun: (
      runId: string,
      body: RunLifecycleCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/runs/${encodeURIComponent(runId)}/start`,
        body,
        idempotencyKey,
        runMutationResponseSchema,
      ),
    proposeExperiment: (
      runId: string,
      body: ProposeExperimentCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/runs/${encodeURIComponent(runId)}/experiments`,
        body,
        idempotencyKey,
        experimentMutationResponseSchema,
      ),
    completeRun: (
      runId: string,
      body: RunLifecycleCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/runs/${encodeURIComponent(runId)}/complete`,
        body,
        idempotencyKey,
        runMutationResponseSchema,
      ),
    cancelRun: (
      runId: string,
      body: RunLifecycleCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/runs/${encodeURIComponent(runId)}/cancel`,
        body,
        idempotencyKey,
        runMutationResponseSchema,
      ),
    startExperiment: (
      experimentId: string,
      body: ExperimentLifecycleCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/experiments/${encodeURIComponent(experimentId)}/start`,
        body,
        idempotencyKey,
        experimentMutationResponseSchema,
      ),
    recordObservation: (
      experimentId: string,
      body: RecordObservationCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/experiments/${encodeURIComponent(experimentId)}/observations`,
        body,
        idempotencyKey,
        observationMutationResponseSchema,
      ),
    decideExperiment: (
      experimentId: string,
      body: DecideExperimentCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/experiments/${encodeURIComponent(experimentId)}/decision`,
        body,
        idempotencyKey,
        experimentMutationResponseSchema,
      ),
    createLearning: (
      experimentId: string,
      body: CreateLearningCommand,
      idempotencyKey: string,
    ) =>
      command(
        `/v1/experiments/${encodeURIComponent(experimentId)}/learnings`,
        body,
        idempotencyKey,
        learningMutationResponseSchema,
      ),
  };
}
