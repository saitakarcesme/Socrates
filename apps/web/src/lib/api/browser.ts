import { createControlPlaneClient } from "./client";

export function createBrowserControlPlaneClient() {
  return createControlPlaneClient({ baseUrl: "/control-plane" });
}

export function runEventStreamUrl(runId: string, after = 0): string {
  return `/control-plane/v1/runs/${encodeURIComponent(
    runId,
  )}/events?after=${after}`;
}
