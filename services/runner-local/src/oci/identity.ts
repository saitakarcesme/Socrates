import { createHash } from "node:crypto";

export type SandboxAttemptIdentity = Readonly<{
  runnerId: string;
  taskId: string;
  attemptId: string;
  fence: number;
}>;

export type SandboxOwnership = Readonly<{
  key: string;
  containerName: string;
  labels: Readonly<Record<string, string>>;
}>;

const identifierPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentifier(name: string, value: string): void {
  if (!identifierPattern.test(value)) {
    throw new TypeError(`${name} must be a UUID.`);
  }
}

export function sandboxAttemptKey(identity: SandboxAttemptIdentity): string {
  assertIdentifier("runnerId", identity.runnerId);
  assertIdentifier("taskId", identity.taskId);
  assertIdentifier("attemptId", identity.attemptId);
  if (!Number.isSafeInteger(identity.fence) || identity.fence < 1) {
    throw new RangeError("fence must be a positive safe integer.");
  }
  return digest(
    `${identity.runnerId}:${identity.taskId}:${identity.attemptId}:${identity.fence}`,
  );
}

export function createSandboxOwnership(
  deploymentId: string,
  identity: SandboxAttemptIdentity,
): SandboxOwnership {
  if (!deploymentId.trim()) {
    throw new TypeError("deploymentId cannot be empty.");
  }
  const key = sandboxAttemptKey(identity);
  return Object.freeze({
    key,
    containerName: `socrates-${key.slice(0, 32)}`,
    labels: Object.freeze({
      "socrates.managed": "true",
      "socrates.deployment": digest(deploymentId),
      "socrates.runner": digest(identity.runnerId),
      "socrates.attempt": key,
      "socrates.fence": String(identity.fence),
    }),
  });
}

export function ownershipFilterArguments(
  ownership: Pick<SandboxOwnership, "labels">,
): readonly string[] {
  return Object.entries(ownership.labels)
    .filter(([name]) =>
      ["socrates.managed", "socrates.deployment", "socrates.runner"].includes(
        name,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

export function runnerOwnershipLabels(
  deploymentId: string,
  runnerId: string,
): Readonly<Record<string, string>> {
  if (!deploymentId.trim()) {
    throw new TypeError("deploymentId cannot be empty.");
  }
  assertIdentifier("runnerId", runnerId);
  return Object.freeze({
    "socrates.managed": "true",
    "socrates.deployment": digest(deploymentId),
    "socrates.runner": digest(runnerId),
  });
}
