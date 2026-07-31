import {
  apiErrorSchema,
  runnerBearerTokenSchema,
  runnerEventSubmitRequestV1Schema,
  runnerEventSubmitResponseV1Schema,
  runnerTaskDeliveryAcquireRequestV1Schema,
  runnerTaskDeliveryAcquireResponseV1Schema,
  runnerTaskDeliveryClaimParamsV1Schema,
  runnerTaskDeliveryClaimRequestV1Schema,
  runnerTaskClaimParamsV1Schema,
  runnerTaskClaimRequestV1Schema,
  runnerTaskClaimResponseV1Schema,
  runnerTaskHeartbeatParamsV1Schema,
  runnerTaskHeartbeatRequestV1Schema,
  runnerTaskHeartbeatResponseV1Schema,
  type ApiErrorCode,
  type RunnerEventSubmitResponseV1,
  type RunnerEventV2,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
  type RunnerTaskClaimRequestV1,
  type RunnerTaskHeartbeatRequestV1,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";

export type RunnerTransportErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "protocol"
  | "server"
  | "response_too_large";

export class RunnerTransportError extends Error {
  constructor(
    readonly code: RunnerTransportErrorCode,
    message: string,
    readonly response?: {
      status: number;
      apiCode: ApiErrorCode;
      requestId: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerTransportError";
  }
}

export interface RunnerControlPlaneClient {
  acquireTaskDelivery(
    signal?: AbortSignal,
  ): Promise<RunnerTaskDeliveryV1 | null>;
  claimTaskDelivery(
    deliveryId: string,
    request: {
      version: "1";
      taskId: string;
      attemptId: string;
      leaseDurationMs: number;
    },
    signal?: AbortSignal,
  ): Promise<RunnerExecutionV1>;
  claimTask(
    taskId: string,
    request: RunnerTaskClaimRequestV1,
    signal?: AbortSignal,
  ): Promise<RunnerExecutionV1>;
  heartbeat(
    input: {
      taskId: string;
      attemptId: string;
      request: RunnerTaskHeartbeatRequestV1;
    },
    signal?: AbortSignal,
  ): Promise<RunnerTaskHeartbeatResponseV1>;
  submitEvent(
    event: RunnerEventV2,
    signal?: AbortSignal,
  ): Promise<RunnerEventSubmitResponseV1>;
}

export type RunnerHttpClientOptions = {
  baseUrl: string | URL;
  credential: string;
  timeoutMs: number;
  maximumResponseBytes: number;
  allowInsecureHttp?: boolean;
  fetch?: typeof fetch;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function controlPlaneBase(
  value: string | URL,
  allowInsecureHttp: boolean,
): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new RunnerTransportError(
      "protocol",
      "The control-plane base URL must contain only an origin.",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(allowInsecureHttp && url.protocol === "http:")
  ) {
    throw new RunnerTransportError(
      "protocol",
      "The control-plane URL requires HTTPS.",
    );
  }
  return new URL(url.origin);
}

function isJsonMediaType(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

async function boundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RunnerTransportError(
          "response_too_large",
          "The control-plane response exceeded its byte limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new RunnerTransportError(
      "protocol",
      "The control-plane response is not valid UTF-8 JSON.",
      undefined,
      { cause },
    );
  }
}

function responseError(status: number, body: unknown): RunnerTransportError {
  const parsed = apiErrorSchema.safeParse(body);
  if (!parsed.success) {
    return new RunnerTransportError(
      "protocol",
      "The control-plane error response does not match its contract.",
    );
  }
  const metadata = {
    status,
    apiCode: parsed.data.error.code,
    requestId: parsed.data.error.requestId,
  };
  const code: RunnerTransportErrorCode =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 409
          ? "conflict"
          : status >= 500
            ? "server"
            : "protocol";
  return new RunnerTransportError(
    code,
    "The control plane rejected the runner operation.",
    metadata,
  );
}

export class RunnerHttpClient implements RunnerControlPlaneClient {
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: RunnerHttpClientOptions) {
    this.#baseUrl = controlPlaneBase(
      options.baseUrl,
      options.allowInsecureHttp ?? false,
    );
    const credential = runnerBearerTokenSchema.safeParse(options.credential);
    if (!credential.success) {
      throw new RunnerTransportError(
        "protocol",
        "The runner credential format is invalid.",
      );
    }
    this.#credential = credential.data;
    this.#timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs");
    this.#maximumResponseBytes = positiveInteger(
      options.maximumResponseBytes,
      "maximumResponseBytes",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async acquireTaskDelivery(
    signal?: AbortSignal,
  ): Promise<RunnerTaskDeliveryV1 | null> {
    const response = await this.#request(
      "/v1/runner/task-deliveries/acquire",
      runnerTaskDeliveryAcquireRequestV1Schema.parse({ version: "1" }),
      runnerTaskDeliveryAcquireResponseV1Schema,
      signal,
      true,
    );
    return response?.delivery ?? null;
  }

  async claimTaskDelivery(
    deliveryId: string,
    request: {
      version: "1";
      taskId: string;
      attemptId: string;
      leaseDurationMs: number;
    },
    signal?: AbortSignal,
  ): Promise<RunnerExecutionV1> {
    const params = runnerTaskDeliveryClaimParamsV1Schema.parse({ deliveryId });
    const body = runnerTaskDeliveryClaimRequestV1Schema.parse(request);
    const response = await this.#request(
      `/v1/runner/task-deliveries/${params.deliveryId}/claims`,
      body,
      runnerTaskClaimResponseV1Schema,
      signal,
    );
    return response.execution;
  }

  async claimTask(
    taskId: string,
    request: RunnerTaskClaimRequestV1,
    signal?: AbortSignal,
  ): Promise<RunnerExecutionV1> {
    const params = runnerTaskClaimParamsV1Schema.parse({ taskId });
    const body = runnerTaskClaimRequestV1Schema.parse(request);
    const response = await this.#request(
      `/v1/runner/tasks/${params.taskId}/claims`,
      body,
      runnerTaskClaimResponseV1Schema,
      signal,
    );
    return response.execution;
  }

  heartbeat(
    input: {
      taskId: string;
      attemptId: string;
      request: RunnerTaskHeartbeatRequestV1;
    },
    signal?: AbortSignal,
  ): Promise<RunnerTaskHeartbeatResponseV1> {
    const params = runnerTaskHeartbeatParamsV1Schema.parse(input);
    const body = runnerTaskHeartbeatRequestV1Schema.parse(input.request);
    return this.#request(
      `/v1/runner/tasks/${params.taskId}/attempts/${params.attemptId}/heartbeat`,
      body,
      runnerTaskHeartbeatResponseV1Schema,
      signal,
    );
  }

  submitEvent(
    event: RunnerEventV2,
    signal?: AbortSignal,
  ): Promise<RunnerEventSubmitResponseV1> {
    const body = runnerEventSubmitRequestV1Schema.parse({
      version: "1",
      event,
    });
    return this.#request(
      "/v1/runner/events",
      body,
      runnerEventSubmitResponseV1Schema,
      signal,
    );
  }

  async #request<T>(
    pathname: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    callerSignal?: AbortSignal,
    allowNoContent?: false,
  ): Promise<T>;
  async #request<T>(
    pathname: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    callerSignal: AbortSignal | undefined,
    allowNoContent: true,
  ): Promise<T | null>;
  async #request<T>(
    pathname: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    callerSignal?: AbortSignal,
    allowNoContent = false,
  ): Promise<T | null> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetch(new URL(pathname, this.#baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (callerSignal?.aborted) {
        throw new RunnerTransportError(
          "aborted",
          "The runner transport operation was cancelled.",
          undefined,
          { cause },
        );
      }
      if (timeoutSignal.aborted) {
        throw new RunnerTransportError(
          "timeout",
          "The runner transport operation timed out.",
          undefined,
          { cause },
        );
      }
      throw new RunnerTransportError(
        "network",
        "The runner transport outcome is unknown after a network failure.",
        undefined,
        { cause },
      );
    }

    if (allowNoContent && response.status === 204) {
      if (response.body && (await boundedBody(response, 1)).byteLength !== 0) {
        throw new RunnerTransportError(
          "protocol",
          "A no-work response contained a body.",
        );
      }
      return null;
    }
    if (!isJsonMediaType(response)) {
      throw new RunnerTransportError(
        "protocol",
        "The control-plane response media type is invalid.",
      );
    }
    const decoded = parseJson(
      await boundedBody(response, this.#maximumResponseBytes),
    );
    if (response.status !== 200) throw responseError(response.status, decoded);
    try {
      return schema.parse(decoded);
    } catch {
      throw new RunnerTransportError(
        "protocol",
        "The control-plane success response does not match its contract.",
      );
    }
  }
}
