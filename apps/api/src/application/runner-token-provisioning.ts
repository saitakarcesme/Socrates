import { entityIdSchema } from "@socrates/contracts";
import type { RunnerCredentialRepository } from "@socrates/database";
import {
  generateRunnerCredential,
  type GeneratedRunnerCredential,
} from "@socrates/runner-auth";

export type RunnerTokenProvisioningInput = {
  runnerId: string;
  label: string;
  expiresAt: Date;
};

export async function provisionRunnerToken(
  credentials: RunnerCredentialRepository,
  input: RunnerTokenProvisioningInput,
  generate: () => GeneratedRunnerCredential = generateRunnerCredential,
): Promise<string> {
  const runnerId = entityIdSchema.parse(input.runnerId);
  const label = input.label.trim();
  if (label.length === 0 || label.length > 80) {
    throw new Error("Runner credential label must contain 1 to 80 characters.");
  }
  if (
    Number.isNaN(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= Date.now()
  ) {
    throw new Error("Runner credential expiry must be in the future.");
  }

  const generated = generate();
  const result = await credentials.provision({
    tokenId: generated.tokenId,
    runnerId,
    secretDigest: generated.secretDigest,
    label,
    expiresAt: input.expiresAt,
  });

  switch (result.state) {
    case "created":
      return generated.credential;
    case "runner_not_found":
      throw new Error("The runner registration does not exist.");
    case "token_conflict":
      throw new Error("The generated runner token identity conflicts.");
  }
}
