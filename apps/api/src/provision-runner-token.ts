import { createPersistence } from "@socrates/database";

import { provisionRunnerToken } from "./application/runner-token-provisioning";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument.`);
  }
  return value;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const persistence = createPersistence({
  connectionString,
  maximumConnections: 1,
});
try {
  const credential = await provisionRunnerToken(persistence.runnerCredentials, {
    runnerId: argument("--runner-id"),
    label: argument("--label"),
    expiresAt: new Date(argument("--expires-at")),
  });
  process.stdout.write(`${credential}\n`);
} finally {
  await persistence.close();
}
