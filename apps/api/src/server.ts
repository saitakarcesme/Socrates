import { serve } from "@hono/node-server";
import { createPersistence } from "@socrates/database";

import { createApp, developmentWorkspaceId } from "./app";

const port = Number(process.env.PORT ?? 3001);
const connectionString = process.env.DATABASE_URL;
const persistence = connectionString
  ? createPersistence({ connectionString })
  : null;
const app = createApp({
  reads: persistence?.reads,
  workspaceId: process.env.WORKSPACE_ID ?? developmentWorkspaceId,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Socrates API listening on http://localhost:${info.port}`);
});

async function shutdown() {
  server.close(async () => {
    await persistence?.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
