import { describe, expect, it } from "vitest";

import { createApp } from "./app";

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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      checks: {
        api: "ok",
        database: "not_configured",
        runnerGateway: "not_configured",
      },
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
