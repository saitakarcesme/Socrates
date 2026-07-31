import {
  apiErrorSchema,
  runnerAttemptReconcileParamsV1Schema,
  runnerAttemptReconcileRequestV1Schema,
  runnerAttemptReconcileResponseV1Schema,
  runnerBearerTokenSchema,
  runnerEventSubmitRequestV1Schema,
  runnerEventSubmitResponseV1Schema,
  runnerSourceSnapshotResolveParamsV1Schema,
  runnerSourceSnapshotResolveRequestV1Schema,
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
  type RunnerAttemptReconcileRequestV1,
  type RunnerAttemptReconcileResponseV1,
  type RunnerEventSubmitResponseV1,
  type RunnerEventV2,
  type RunnerExecutionV1,
  type RunnerTaskDeliveryV1,
  type RunnerTaskClaimRequestV1,
  type RunnerTaskHeartbeatRequestV1,
  type RunnerTaskHeartbeatResponseV1,
} from "@socrates/contracts";

import { sandboxAttemptKey } from "../oci/identity";
import type {
  RunnerSourceSnapshotTransport,
  SourceSnapshotStream,
} from "../source/artifact-resolver";
import { sourceSnapshotMediaType } from "../source/materializer";

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
  reconcileAttempt(
    input: {
      taskId: string;
      attemptId: string;
      request: RunnerAttemptReconcileRequestV1;
    },
    signal?: AbortSignal,
  ): Promise<RunnerAttemptReconcileResponseV1>;
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
  maximumSourceBytes: number;
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

export class RunnerHttpClient
  implements RunnerControlPlaneClient, RunnerSourceSnapshotTransport
{
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #maximumSourceBytes: number;
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
    this.#maximumSourceBytes = positiveInteger(
      options.maximumSourceBytes,
      "maximumSourceBytes",
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

  reconcileAttempt(
    input: {
      taskId: string;
      attemptId: string;
      request: RunnerAttemptReconcileRequestV1;
    },
    signal?: AbortSignal,
  ): Promise<RunnerAttemptReconcileResponseV1> {
    const params = runnerAttemptReconcileParamsV1Schema.parse({
      taskId: input.taskId,
      attemptId: input.attemptId,
    });
    const body = runnerAttemptReconcileRequestV1Schema.parse(input.request);
    return this.#request(
      `/v1/runner/tasks/${params.taskId}/attempts/${params.attemptId}/reconciliation`,
      body,
      runnerAttemptReconcileResponseV1Schema,
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

  async open(input: {
    identity: {
      runnerId: string;
      taskId: string;
      attemptId: string;
      fence: number;
    };
    snapshotId: string;
    digest: string;
    signal?: AbortSignal;
  }): Promise<SourceSnapshotStream | undefined> {
    sandboxAttemptKey(input.identity);
    const params = runnerSourceSnapshotResolveParamsV1Schema.parse({
      taskId: input.identity.taskId,
      attemptId: input.identity.attemptId,
    });
    const body = runnerSourceSnapshotResolveRequestV1Schema.parse({
      version: "1",
      fence: input.identity.fence,
      snapshotId: input.snapshotId,
      digest: input.digest,
    });
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetch(
        new URL(
          `/v1/runner/tasks/${params.taskId}/attempts/${params.attemptId}/source-snapshots/resolve`,
          this.#baseUrl,
        ),
        {
          method: "POST",
          headers: {
            accept: sourceSnapshotMediaType,
            authorization: `Bearer ${this.#credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "manual",
          signal,
        },
      );
    } catch (cause) {
      throw this.#transportFailure(cause, input.signal, timeoutSignal);
    }

    if (response.status !== 200) {
      if (!isJsonMediaType(response)) {
        await response.body?.cancel();
        throw new RunnerTransportError(
          "protocol",
          "The source error response media type is invalid.",
        );
      }
      let errorBody: Uint8Array;
      try {
        errorBody = await boundedBody(response, this.#maximumResponseBytes);
      } catch (cause) {
        throw this.#transportFailure(cause, input.signal, timeoutSignal);
      }
      const decoded = parseJson(errorBody);
      const parsed = apiErrorSchema.safeParse(decoded);
      if (
        response.status === 404 &&
        parsed.success &&
        parsed.data.error.code === "not_found"
      ) {
        return undefined;
      }
      throw responseError(response.status, decoded);
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const contentLength = response.headers.get("content-length");
    if (
      mediaType !== sourceSnapshotMediaType ||
      !contentLength ||
      !/^[1-9]\d*$/u.test(contentLength)
    ) {
      await response.body?.cancel();
      throw new RunnerTransportError(
        "protocol",
        "The source response descriptor is invalid.",
      );
    }
    const sizeBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes > this.#maximumSourceBytes
    ) {
      await response.body?.cancel();
      throw new RunnerTransportError(
        "response_too_large",
        "The source response exceeds its configured byte limit.",
      );
    }
    if (!response.body) {
      throw new RunnerTransportError(
        "protocol",
        "The source response has no body.",
      );
    }

    const responseBody = response.body;
    const maximumSourceBytes = this.#maximumSourceBytes;
    const transportFailure = this.#transportFailure.bind(this);
    let consumed = false;
    const content: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        if (consumed) {
          throw new RunnerTransportError(
            "protocol",
            "The source response stream can only be consumed once.",
          );
        }
        consumed = true;
        const reader = responseBody.getReader();
        let total = 0;
        let complete = false;
        try {
          while (true) {
            let next;
            try {
              next = await reader.read();
            } catch (cause) {
              throw transportFailure(cause, input.signal, timeoutSignal);
            }
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximumSourceBytes) {
              throw new RunnerTransportError(
                "response_too_large",
                "The source response exceeded its configured byte limit.",
              );
            }
            if (total > sizeBytes) {
              throw new RunnerTransportError(
                "protocol",
                "The source response exceeded its declared byte length.",
              );
            }
            yield next.value;
          }
          if (input.signal?.aborted || timeoutSignal.aborted) {
            throw transportFailure(signal.reason, input.signal, timeoutSignal);
          }
          if (total !== sizeBytes) {
            throw new RunnerTransportError(
              "protocol",
              "The source response did not match its declared byte length.",
            );
          }
          complete = true;
        } finally {
          if (!complete) await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    };
    return Object.freeze({ mediaType, sizeBytes, content });
  }

  #transportFailure(
    cause: unknown,
    callerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): RunnerTransportError {
    if (cause instanceof RunnerTransportError) return cause;
    if (callerSignal?.aborted) {
      return new RunnerTransportError(
        "aborted",
        "The runner transport operation was cancelled.",
        undefined,
        { cause },
      );
    }
    if (timeoutSignal.aborted) {
      return new RunnerTransportError(
        "timeout",
        "The runner transport operation timed out.",
        undefined,
        { cause },
      );
    }
    return new RunnerTransportError(
      "network",
      "The runner transport outcome is unknown after a network failure.",
      undefined,
      { cause },
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
