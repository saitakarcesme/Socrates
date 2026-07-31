import { describe, expect, it } from "vitest";

import {
  createSandboxOwnership,
  ownershipFilterArguments,
  sandboxAttemptKey,
} from "./identity";
import { fixtureIdentity } from "./test-fixtures";

describe("sandbox ownership", () => {
  it("derives stable opaque names and exact scoped labels", () => {
    const first = createSandboxOwnership("deployment-a", fixtureIdentity);
    const second = createSandboxOwnership("deployment-a", fixtureIdentity);

    expect(first).toEqual(second);
    expect(first.containerName).toMatch(/^socrates-[a-f0-9]{32}$/);
    expect(JSON.stringify(first)).not.toContain(fixtureIdentity.taskId);
    expect(first.labels["socrates.attempt"]).toBe(
      sandboxAttemptKey(fixtureIdentity),
    );
    expect(ownershipFilterArguments(first)).toEqual([
      "--filter",
      `label=socrates.deployment=${first.labels["socrates.deployment"]}`,
      "--filter",
      "label=socrates.managed=true",
      "--filter",
      `label=socrates.runner=${first.labels["socrates.runner"]}`,
    ]);
  });

  it("changes identity when the fence changes", () => {
    expect(
      sandboxAttemptKey({
        ...fixtureIdentity,
        fence: fixtureIdentity.fence + 1,
      }),
    ).not.toBe(sandboxAttemptKey(fixtureIdentity));
  });

  it("rejects invalid protocol identities", () => {
    expect(() =>
      sandboxAttemptKey({ ...fixtureIdentity, runnerId: "../../host" }),
    ).toThrow("runnerId must be a UUID");
    expect(() => sandboxAttemptKey({ ...fixtureIdentity, fence: 0 })).toThrow(
      "fence must be a positive",
    );
  });
});
