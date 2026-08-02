import { describe, expect, it } from "vitest";

import {
  createSandboxOwnership,
  ownershipFilterArguments,
  sandboxAttemptIdentitySnapshot,
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

  it("captures an exact deeply immutable attempt identity", () => {
    const mutable = { ...fixtureIdentity };
    const captured = sandboxAttemptIdentitySnapshot(mutable);
    mutable.fence += 1;

    expect(captured).toEqual(fixtureIdentity);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("rejects missing, additional, and malformed identity authority", () => {
    expect(() =>
      sandboxAttemptIdentitySnapshot({
        ...fixtureIdentity,
        scope: "foreign",
      }),
    ).toThrow("shape is invalid");
    const missing = {
      runnerId: fixtureIdentity.runnerId,
      taskId: fixtureIdentity.taskId,
      attemptId: fixtureIdentity.attemptId,
    };
    expect(() => sandboxAttemptIdentitySnapshot(missing)).toThrow(
      "shape is invalid",
    );
    expect(() =>
      sandboxAttemptIdentitySnapshot({ ...fixtureIdentity, fence: 0 }),
    ).toThrow("fence must be a positive");
  });
});
