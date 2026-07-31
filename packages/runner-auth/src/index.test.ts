import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  generateRunnerCredential,
  OpaqueRunnerAuthenticator,
  type RunnerCredentialCandidate,
} from "./index";

const runnerId = "019c1170-8b7a-7a60-b7f8-f35c85d75010";
const workspaceId = "019c1170-8b7a-7a60-b7f8-f35c85d75000";

function candidate(
  generated: ReturnType<typeof generateRunnerCredential>,
  usable = true,
): RunnerCredentialCandidate {
  return {
    tokenId: generated.tokenId,
    runnerId,
    workspaceId,
    secretDigest: generated.secretDigest,
    usable,
  };
}

describe("opaque runner authentication", () => {
  it("generates a fixed credential and stores only its digest", () => {
    const secret = Buffer.alloc(32, 7);
    const tokenId = randomUUID();
    const generated = generateRunnerCredential({
      randomBytes: () => secret,
      randomUUID: () => tokenId,
    });

    expect(generated).toEqual({
      tokenId,
      credential: `srt1.${tokenId}.${secret.toString("base64url")}`,
      secretDigest: createHash("sha256").update(secret).digest("hex"),
    });
    expect(generated.secretDigest).not.toContain(secret.toString("base64url"));
  });

  it("returns only the principal for an exact usable digest", async () => {
    const generated = generateRunnerCredential();
    const findCandidate = vi.fn(async () => candidate(generated));

    await expect(
      new OpaqueRunnerAuthenticator({ findCandidate }).authenticate(
        generated.credential,
      ),
    ).resolves.toEqual({ tokenId: generated.tokenId, runnerId, workspaceId });
    expect(findCandidate).toHaveBeenCalledWith(generated.tokenId);
  });

  it("collapses malformed, wrong, unavailable, and unknown credentials", async () => {
    const generated = generateRunnerCredential();
    const other = generateRunnerCredential({
      randomUUID: () => generated.tokenId,
    });

    for (const [credential, found] of [
      ["not-a-token", candidate(generated)],
      [other.credential, candidate(generated)],
      [generated.credential, candidate(generated, false)],
      [generated.credential, null],
    ] as const) {
      const authenticator = new OpaqueRunnerAuthenticator({
        findCandidate: async () => found,
      });
      await expect(authenticator.authenticate(credential)).resolves.toBeNull();
    }
  });

  it("fails closed when the entropy source returns the wrong size", () => {
    expect(() =>
      generateRunnerCredential({ randomBytes: () => Buffer.alloc(31) }),
    ).toThrow("wrong size");
  });
});
