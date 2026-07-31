import { randomUUID } from "node:crypto";

import type { RunnerEventV2 } from "@socrates/contracts";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { describe, expect, it, vi } from "vitest";

import { createRunnerRoutes, type RunnerRouteOptions } from "./routes";

const principal = {
  tokenId: randomUUID(),
  runnerId: randomUUID(),
  workspaceId: randomUUID(),
};
const credential = `srt1.${principal.tokenId}.${"a".repeat(43)}`;

function event(runnerId = principal.runnerId): RunnerEventV2 {
  return {
    version: "2",
    eventId: randomUUID(),
    runnerId,
    taskId: randomUUID(),
    attemptId: randomUUID(),
    fence: 1,
    sequence: 1,
    occurredAt: "2026-07-31T12:00:00.000Z",
    type: "task.failed",
    payload: {
      classification: "infrastructure",
      message: "The controlled runtime failed.",
    },
  };
}

function app(options: RunnerRouteOptions) {
  const application = new Hono();
  application.use("*", requestId());
  application.route("/v1/runner", createRunnerRoutes(options));
  return application;
}

function authenticatedOptions(
  overrides: Partial<RunnerRouteOptions["gateway"]> = {},
): RunnerRouteOptions {
  return {
    authenticator: {
      authenticate: async (value) => (value === credential ? principal : null),
    },
    gateway: {
      claimTask: async () => {
        throw new Error("Unexpected claim.");
      },
      heartbeat: async () => ({
        leaseExpiresAt: new Date("2026-07-31T12:01:00.000Z"),
        directive: "continue",
      }),
      ingestEvent: async ({ event: value }) => {
        const submitted = value as RunnerEventV2;
        return {
          replay: false,
          acknowledgement: {
            eventId: submitted.eventId,
            attemptId: submitted.attemptId,
            acknowledgedSequence: submitted.sequence,
            expectedSequence: submitted.sequence + 1,
            receivedAt: new Date("2026-07-31T12:00:01.000Z"),
          },
        };
      },
      ...overrides,
    },
  };
}

function headers(token = credential) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

describe("runner HTTP routes", () => {
  it("keeps the entire route surface unavailable without both dependencies", async () => {
    const response = await app({ authenticator: null, gateway: null }).request(
      "/v1/runner/events",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_unavailable" },
    });
  });

  it("authenticates before invoking a gateway command", async () => {
    const ingestEvent = vi.fn();
    const options = authenticatedOptions({ ingestEvent });
    const response = await app(options).request("/v1/runner/events", {
      method: "POST",
      headers: headers("invalid"),
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="socrates-runner"',
    );
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it("injects the principal into a fenced heartbeat", async () => {
    const heartbeat = vi.fn(async () => ({
      leaseExpiresAt: new Date("2026-07-31T12:01:00.000Z"),
      directive: "cancel" as const,
    }));
    const taskId = randomUUID();
    const attemptId = randomUUID();
    const response = await app(authenticatedOptions({ heartbeat })).request(
      `/v1/runner/tasks/${taskId}/attempts/${attemptId}/heartbeat`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          version: "1",
          fence: 4,
          leaseDurationMs: 30_000,
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "1",
      leaseExpiresAt: "2026-07-31T12:01:00.000Z",
      directive: "cancel",
    });
    expect(heartbeat).toHaveBeenCalledWith({
      runnerId: principal.runnerId,
      taskId,
      attemptId,
      fence: 4,
      leaseDurationMs: 30_000,
    });
  });

  it("rejects an event for another runner before ingestion", async () => {
    const ingestEvent = vi.fn();
    const foreign = event(randomUUID());
    const response = await app(authenticatedOptions({ ingestEvent })).request(
      "/v1/runner/events",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ version: "1", event: foreign }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden" },
    });
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it("serializes only the committed event acknowledgement", async () => {
    const submitted = event();
    const response = await app(authenticatedOptions()).request(
      "/v1/runner/events",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ version: "1", event: submitted }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
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

  it("rejects an oversized streamed body before JSON validation", async () => {
    const ingestEvent = vi.fn();
    const response = await app(authenticatedOptions({ ingestEvent })).request(
      "/v1/runner/events",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ padding: "x".repeat(140_000) }),
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(ingestEvent).not.toHaveBeenCalled();
  });
});
