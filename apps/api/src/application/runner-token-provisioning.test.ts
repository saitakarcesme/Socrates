import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { provisionRunnerToken } from "./runner-token-provisioning";

const generated = {
  tokenId: randomUUID(),
  credential: `srt1.${randomUUID()}.${"a".repeat(43)}`,
  secretDigest: "b".repeat(64),
};

describe("runner token provisioning", () => {
  it("reveals the credential only after its digest is committed", async () => {
    const provision = vi.fn(async () => ({ state: "created" as const }));
    const expiresAt = new Date(Date.now() + 60_000);
    const runnerId = randomUUID();

    await expect(
      provisionRunnerToken(
        { findCandidate: async () => null, provision },
        { runnerId, label: "local runner", expiresAt },
        () => generated,
      ),
    ).resolves.toBe(generated.credential);
    expect(provision).toHaveBeenCalledWith({
      tokenId: generated.tokenId,
      runnerId,
      secretDigest: generated.secretDigest,
      label: "local runner",
      expiresAt,
    });
  });

  it.each(["runner_not_found", "token_conflict"] as const)(
    "does not include the raw credential when persistence returns %s",
    async (state) => {
      const operation = provisionRunnerToken(
        {
          findCandidate: async () => null,
          provision: async () => ({ state }),
        },
        {
          runnerId: randomUUID(),
          label: "local runner",
          expiresAt: new Date(Date.now() + 60_000),
        },
        () => generated,
      );

      await expect(operation).rejects.not.toThrow(generated.credential);
    },
  );

  it("rejects expired operator input before generating a credential", async () => {
    const generate = vi.fn(() => generated);
    await expect(
      provisionRunnerToken(
        {
          findCandidate: async () => null,
          provision: async () => ({ state: "created" }),
        },
        {
          runnerId: randomUUID(),
          label: "local runner",
          expiresAt: new Date(0),
        },
        generate,
      ),
    ).rejects.toThrow("future");
    expect(generate).not.toHaveBeenCalled();
  });
});
