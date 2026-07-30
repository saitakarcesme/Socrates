import { serve } from "@hono/node-server";
import {
  assertDatabaseCompatibility,
  createPersistence,
} from "@socrates/database";

import { createApp, developmentWorkspaceId } from "./app";

const port = Number(process.env.PORT ?? 3001);
const connectionString = process.env.DATABASE_URL;
if (connectionString) {
  await assertDatabaseCompatibility(connectionString);
}
const persistence = connectionString
  ? createPersistence({ connectionString })
  : null;
const app = createApp({
  manualResearchEnabled:
    process.env.MANUAL_RESEARCH_ENABLED?.trim().toLowerCase() === "true",
  ...(persistence ? { persistence } : {}),
  workspaceId: process.env.WORKSPACE_ID ?? developmentWorkspaceId,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Socrates API listening on http://localhost:${info.port}`);
});

async function shutdown() {
  const forcedShutdown = setTimeout(() => {
    if (
      "closeAllConnections" in server &&
      typeof server.closeAllConnections === "function"
    ) {
      server.closeAllConnections();
    }
  }, 5_000);
  forcedShutdown.unref();

  server.close(async () => {
    clearTimeout(forcedShutdown);
    await persistence?.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
