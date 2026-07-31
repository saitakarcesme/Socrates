import { randomUUID } from "node:crypto";

import type { RunnerEventV2 } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import { RunnerHttpClient, RunnerTransportError } from "./client";

const credential = `srt1.${randomUUID()}.${"a".repeat(43)}`;

function event(): RunnerEventV2 {
  return {
    version: "2",
    eventId: randomUUID(),
    runnerId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fence: 1,
    sequence: 1,
    occurredAt: "2026-07-31T12:00:00.000Z",
    type: "task.failed",
    payload: {
      classification: "infrastructure",
      message: "Controlled failure.",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function client(
  fetchImplementation: typeof fetch,
  options: { maximumResponseBytes?: number; timeoutMs?: number } = {},
) {
  return new RunnerHttpClient({
    baseUrl: "http://control-plane.test",
    credential,
    timeoutMs: options.timeoutMs ?? 1_000,
    maximumResponseBytes: options.maximumResponseBytes ?? 16_384,
    allowInsecureHttp: true,
    fetch: fetchImplementation,
  });
}

describe("runner HTTP client", () => {
  it("acquires one strict delivery or accepts an empty 204 response", async () => {
    const delivery = {
      version: "1" as const,
      deliveryId: randomUUID(),
      taskId: randomUUID(),
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "http://control-plane.test/v1/runner/task-deliveries/acquire",
      );
      expect(JSON.parse(String(init?.body))).toEqual({ version: "1" });
      return jsonResponse({ version: "1", delivery });
    });
    await expect(
      client(fetchImplementation).acquireTaskDelivery(),
    ).resolves.toEqual(delivery);
    await expect(
      client(
        async () => new Response(null, { status: 204 }),
      ).acquireTaskDelivery(),
    ).resolves.toBeNull();
  });

  it("submits one immutable event with credentials and validates its acknowledgement", async () => {
    const submitted = event();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://control-plane.test/v1/runner/events");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        version: "1",
        event: submitted,
      });
      return jsonResponse({
        version: "1",
        replay: false,
        acknowledgement: {
          version: "1",
          eventId: submitted.eventId,
          attemptId: submitted.attemptId,
          acknowledgedSequence: 1,
          expectedSequence: 2,
          receivedAt: "2026-07-31T12:00:01.000Z",
        },
      });
    });

    await expect(
      client(fetchImplementation).submitEvent(submitted),
    ).resolves.toMatchObject({
      replay: false,
      acknowledgement: { eventId: submitted.eventId },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("requires HTTPS unless insecure development mode is explicit", () => {
    expect(
      () =>
        new RunnerHttpClient({
          baseUrl: "http://127.0.0.1:3001",
          credential,
          timeoutMs: 1_000,
          maximumResponseBytes: 1_000,
        }),
    ).toThrow("requires HTTPS");
  });

  it("classifies a validated rejection without retaining its body or credential", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: `do not retain ${credential}`,
            requestId: "request-1",
            details: { raw: credential },
          },
        },
        401,
      ),
    );

    const failure = await client(fetchImplementation)
      .submitEvent(event())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "unauthorized",
      response: {
        status: 401,
        apiCode: "unauthorized",
        requestId: "request-1",
      },
    });
    expect(String(failure)).not.toContain(credential);
    expect(JSON.stringify(failure)).not.toContain(credential);
  });

  it("rejects invalid media types and bounded response-body bombs", async () => {
    const wrongMedia = new Response("{}", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    await expect(
      client(async () => wrongMedia).submitEvent(event()),
    ).rejects.toMatchObject({ code: "protocol" });

    await expect(
      client(async () => jsonResponse({ padding: "x".repeat(1_000) }), {
        maximumResponseBytes: 128,
      }).submitEvent(event()),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("separates caller cancellation, timeout, and ambiguous network failure", async () => {
    const pendingFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const cancelled = client(pendingFetch).submitEvent(
      event(),
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "aborted" });

    await expect(
      client(pendingFetch, { timeoutMs: 1 }).submitEvent(event()),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      client(async () => {
        throw new Error("connection reset");
      }).submitEvent(event()),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("rejects redirects and schema-invalid successes", async () => {
    await expect(
      client(async () => jsonResponse({}, 302)).submitEvent(event()),
    ).rejects.toBeInstanceOf(RunnerTransportError);
    await expect(
      client(async () =>
        jsonResponse({ version: "1", replay: false }),
      ).submitEvent(event()),
    ).rejects.toMatchObject({ code: "protocol" });
  });
});
