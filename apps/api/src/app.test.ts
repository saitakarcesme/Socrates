import type { ReadRepository } from "@socrates/database";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app";

function unexpectedRead(): never {
  throw new Error("Read repository should not have been called.");
}

const unreachableReads: ReadRepository = {
  listProjects: async () => unexpectedRead(),
  getProject: async () => unexpectedRead(),
  listRuns: async () => unexpectedRead(),
  getRun: async () => unexpectedRead(),
  listExperiments: async () => unexpectedRead(),
  getExperiment: async () => unexpectedRead(),
  listLearnings: async () => unexpectedRead(),
  listWorkspaceLearnings: async () => unexpectedRead(),
  listRunEvents: async () => unexpectedRead(),
};

describe("control-plane API", () => {
  it("reports a stable health contract", async () => {
    const response = await createApp().request("/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "socrates-api",
      version: "0.0.0",
    });
  });

  it("makes unconfigured dependencies explicit in readiness", async () => {
    const response = await createApp().request("/v1/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      checks: {
        api: "ok",
        database: "not_configured",
        runnerGateway: "not_configured",
      },
    });
  });

  it("reports a configured read dependency", async () => {
    const response = await createApp({ reads: unreachableReads }).request(
      "/v1/ready",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      checks: {
        database: "ok",
      },
    });
  });

  it("returns service unavailable when persistence is absent", async () => {
    const response = await createApp().request("/v1/projects");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "service_unavailable",
      },
    });
  });

  it("returns service unavailable for commands without persistence", async () => {
    const response = await createApp().request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "project-create-test",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_unavailable" },
    });
  });

  it("validates resource identifiers before querying", async () => {
    const response = await createApp({ reads: unreachableReads }).request(
      "/v1/projects/not-a-uuid",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
      },
    });
  });

  it("rejects malformed opaque cursors before querying", async () => {
    const response = await createApp({ reads: unreachableReads }).request(
      "/v1/projects?cursor=***",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "The supplied cursor is invalid.",
      },
    });
  });

  it("reads workspace knowledge without a project fan-out", async () => {
    const listWorkspaceLearnings = vi.fn<
      ReadRepository["listWorkspaceLearnings"]
    >(async () => ({
      items: [
        {
          id: "019c1170-8b7a-7a60-b7f8-f35c85d75001",
          projectId: "019c1170-8b7a-7a60-b7f8-f35c85d75002",
          statement: "A measured change improved the target metric.",
          confidence: 0.9,
          status: "active",
          supersededLearningId: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      nextCursor: null,
    }));
    const response = await createApp({
      reads: { ...unreachableReads, listWorkspaceLearnings },
      workspaceId: "019c1170-8b7a-7a60-b7f8-f35c85d75003",
    }).request("/v1/learnings?limit=25");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{ confidence: 0.9, status: "active" }],
      page: { nextCursor: null },
    });
    expect(listWorkspaceLearnings).toHaveBeenCalledWith({
      workspaceId: "019c1170-8b7a-7a60-b7f8-f35c85d75003",
      cursor: null,
      limit: 25,
    });
  });

  it("returns the API error envelope for unknown resources", async () => {
    const response = await createApp().request("/v1/unknown");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      error: {
        code: "not_found",
        message: "The requested resource does not exist.",
      },
    });
    expect(body.error.requestId).toEqual(expect.any(String));
  });
});
