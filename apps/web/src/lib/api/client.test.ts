import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneContractError,
  ControlPlaneError,
  createControlPlaneClient,
} from "./client";

describe("control-plane client", () => {
  it("builds a no-store request and validates the response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [], page: { nextCursor: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane.internal/",
      fetcher,
    });

    await expect(client.listProjects("next page")).resolves.toEqual({
      data: [],
      page: { nextCursor: null },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://control-plane.internal/v1/projects?limit=100&cursor=next%20page",
      {
        cache: "no-store",
        headers: { accept: "application/json" },
      },
    );
  });

  it("preserves the typed API error envelope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: "The requested project does not exist.",
            requestId: "request-1",
          },
        }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = createControlPlaneClient({
      baseUrl: "/control-plane",
      fetcher,
    });

    const error = await client.getProject("missing").catch((cause) => cause);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      requestId: "request-1",
    });
  });

  it("sends command payloads with the caller-owned idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            projectId: "019c1170-8b7a-7a60-b7f8-f35c85d75001",
            projectVersion: 0,
            currentMetricDefinitionId: "019c1170-8b7a-7a60-b7f8-f35c85d75002",
            guardrails: [],
          },
        }),
        { status: 201 },
      ),
    );
    const client = createControlPlaneClient({
      baseUrl: "/control-plane",
      fetcher,
    });
    const body = {
      name: "Atlas",
      objective: "Improve LCP.",
      metric: {
        name: "LCP",
        unit: "s",
        direction: "minimize" as const,
        minimumImprovement: "0.05",
        noiseTolerance: "0.01",
        guardrails: [],
      },
    };

    await client.createProject(body, "project-create-01");

    expect(fetcher).toHaveBeenCalledWith(
      "/control-plane/v1/projects",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": "project-create-01",
        },
        body: JSON.stringify(body),
      }),
    );
  });

  it("rejects a successful response that violates its contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: "not-a-list" }), { status: 200 }),
      );
    const client = createControlPlaneClient({
      baseUrl: "/control-plane",
      fetcher,
    });

    await expect(client.listProjects()).rejects.toBeInstanceOf(
      ControlPlaneContractError,
    );
  });
});
