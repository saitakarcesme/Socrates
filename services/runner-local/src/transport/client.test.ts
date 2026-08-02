import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalContentAddressedArtifactStore } from "@socrates/artifact-store/local";
import type { RunnerEventV2 } from "@socrates/contracts";
import { describe, expect, it, vi } from "vitest";

import { BoundedSourceArtifactResolverFactory } from "../source/artifact-resolver";
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

const sourceMediaType = "application/vnd.socrates.source-snapshot.v1+tar";

function sourceResponse(content: Uint8Array, declared = content.byteLength) {
  return new Response(content, {
    headers: {
      "content-length": String(declared),
      "content-type": sourceMediaType,
    },
  });
}

async function collect(content: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  return chunks;
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
    maximumSourceBytes: 1_048_576,
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

  it("reconciles one exact attempt without sending a lease duration", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `http://control-plane.test/v1/runner/tasks/${taskId}/attempts/${attemptId}/reconciliation`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        version: "1",
        fence: 3,
      });
      return jsonResponse({
        version: "1",
        state: "current",
        observedAt: "2026-07-31T12:00:00.000Z",
        leaseExpiresAt: "2026-07-31T12:01:00.000Z",
      });
    });

    await expect(
      client(fetchImplementation).reconcileAttempt({
        taskId,
        attemptId,
        request: { version: "1", fence: 3 },
      }),
    ).resolves.toMatchObject({ state: "current" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("heartbeats one exact attempt without mixing the request into route params", async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `http://control-plane.test/v1/runner/tasks/${taskId}/attempts/${attemptId}/heartbeat`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        version: "1",
        fence: 3,
        leaseDurationMs: 30_000,
      });
      return jsonResponse({
        version: "1",
        leaseExpiresAt: "2026-07-31T12:01:00.000Z",
        directive: "continue",
      });
    });

    await expect(
      client(fetchImplementation).heartbeat({
        taskId,
        attemptId,
        request: { version: "1", fence: 3, leaseDurationMs: 30_000 },
      }),
    ).resolves.toMatchObject({ directive: "continue" });
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
          maximumSourceBytes: 1_000,
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

  it("opens one exact authenticated source stream without buffering it", async () => {
    const identity = {
      runnerId: randomUUID(),
      taskId: randomUUID(),
      attemptId: randomUUID(),
      fence: 4,
    };
    const snapshotId = randomUUID();
    const digest = `sha256:${"b".repeat(64)}`;
    const bytes = new TextEncoder().encode("bounded source");
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `http://control-plane.test/v1/runner/tasks/${identity.taskId}/attempts/${identity.attemptId}/source-snapshots/resolve`,
      );
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      expect(new Headers(init?.headers).get("accept")).toBe(sourceMediaType);
      expect(JSON.parse(String(init?.body))).toEqual({
        version: "1",
        fence: 4,
        snapshotId,
        digest,
      });
      return sourceResponse(bytes);
    });

    const descriptor = await client(fetchImplementation).open({
      identity,
      snapshotId,
      digest,
    });
    expect(descriptor).toMatchObject({
      mediaType: sourceMediaType,
      sizeBytes: bytes.byteLength,
    });
    await expect(collect(descriptor!.content)).resolves.toEqual([bytes]);
    await expect(collect(descriptor!.content)).rejects.toMatchObject({
      code: "protocol",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an absent source and rejects redirects or invalid bounds", async () => {
    const input = {
      identity: {
        runnerId: randomUUID(),
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 1,
      },
      snapshotId: randomUUID(),
      digest: `sha256:${"c".repeat(64)}`,
    };
    await expect(
      client(async () =>
        jsonResponse(
          {
            error: {
              code: "not_found",
              message: "Missing.",
              requestId: "request-1",
            },
          },
          404,
        ),
      ).open(input),
    ).resolves.toBeUndefined();
    await expect(
      client(async () => new Response(null, { status: 302 })).open(input),
    ).rejects.toMatchObject({ code: "protocol" });
    await expect(
      client(async () => sourceResponse(new Uint8Array(2), 1_048_577)).open(
        input,
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await expect(
      client(
        async () =>
          new Response(new Uint8Array(1), {
            headers: { "content-length": "1", "content-type": "text/plain" },
          }),
      ).open(input),
    ).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects truncated and oversized source bodies during consumption", async () => {
    const input = {
      identity: {
        runnerId: randomUUID(),
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 2,
      },
      snapshotId: randomUUID(),
      digest: `sha256:${"d".repeat(64)}`,
    };
    const truncated = await client(async () =>
      sourceResponse(new Uint8Array(1), 2),
    ).open(input);
    await expect(collect(truncated!.content)).rejects.toMatchObject({
      code: "protocol",
    });
    const oversized = await client(async () =>
      sourceResponse(new Uint8Array(2), 1),
    ).open(input);
    await expect(collect(oversized!.content)).rejects.toMatchObject({
      code: "protocol",
    });
  });

  it("keeps cancellation and timeout authority active during streaming", async () => {
    const input = {
      identity: {
        runnerId: randomUUID(),
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 3,
      },
      snapshotId: randomUUID(),
      digest: `sha256:${"e".repeat(64)}`,
    };
    const pendingResponse = async (
      _request: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        }),
        {
          headers: {
            "content-length": "1",
            "content-type": sourceMediaType,
          },
        },
      );

    const controller = new AbortController();
    const cancelled = await client(pendingResponse).open({
      ...input,
      signal: controller.signal,
    });
    const consuming = collect(cancelled!.content);
    controller.abort();
    await expect(consuming).rejects.toMatchObject({ code: "aborted" });

    const timed = await client(pendingResponse, { timeoutMs: 5 }).open(input);
    await expect(collect(timed!.content)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("resolves two exact attempt authorities through HTTP into one local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "socrates-http-source-"));
    try {
      const bytes = new TextEncoder().encode("resolver source");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const firstIdentity = {
        runnerId: randomUUID(),
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 8,
      };
      const secondIdentity = {
        runnerId: firstIdentity.runnerId,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        fence: 9,
      };
      const requests: Array<{ url: string; body: unknown }> = [];
      const transport = client(async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return sourceResponse(bytes);
      });
      const factory = new BoundedSourceArtifactResolverFactory({
        maximumArchiveBytes: 1_024,
        transport,
        artifacts: new LocalContentAddressedArtifactStore(root),
      });
      const first = factory.create(firstIdentity);
      const second = factory.create(secondIdentity);

      await expect(
        first.resolve({ snapshotId: randomUUID(), digest }),
      ).resolves.toMatchObject({ digest, sizeBytes: bytes.byteLength });
      await expect(
        second.resolve({ snapshotId: randomUUID(), digest }),
      ).resolves.toMatchObject({ digest, sizeBytes: bytes.byteLength });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        url: expect.stringContaining(
          `/tasks/${firstIdentity.taskId}/attempts/${firstIdentity.attemptId}/`,
        ),
        body: { fence: firstIdentity.fence },
      });
      expect(requests[1]).toMatchObject({
        url: expect.stringContaining(
          `/tasks/${secondIdentity.taskId}/attempts/${secondIdentity.attemptId}/`,
        ),
        body: { fence: secondIdentity.fence },
      });
      expect(first.identity).toEqual(firstIdentity);
      expect(second.identity).toEqual(secondIdentity);
      expect(first).not.toBe(second);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
