import { describe, expect, it } from "vitest";

import { fixtureCredential } from "../platform/test-fixtures";
import {
  LocalRunnerSystemdCredentialLoadError,
  NodeLocalRunnerSystemdCredentialLoader,
} from "./index";

describe("NodeLocalRunnerSystemdCredentialLoader", () => {
  it("is an inert frozen production surface without input authority", () => {
    const loader = new NodeLocalRunnerSystemdCredentialLoader();

    expect(Object.isFrozen(loader)).toBe(true);
    expect(Reflect.ownKeys(loader)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(loader))).toEqual([
      "constructor",
      "load",
    ]);
    expect(NodeLocalRunnerSystemdCredentialLoader).toHaveLength(0);
    expect(loader.load).toHaveLength(0);
  });

  it.skipIf(process.platform === "linux")(
    "fails before environment access on unsupported hosts",
    async () => {
      const error = await new NodeLocalRunnerSystemdCredentialLoader()
        .load()
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(LocalRunnerSystemdCredentialLoadError);
      expect(error).toMatchObject({ code: "unsupported_host" });
      expect(Object.isFrozen(error)).toBe(true);
      expect("cause" in (error as object)).toBe(false);
      expect(JSON.stringify(error)).not.toMatch(/credentials|runner-bearer/u);
      expect((error as Error).message).not.toMatch(
        /credentials|runner-bearer/u,
      );
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL !== "1" ||
      process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL_FAILURE !== undefined,
  )("admits the fixed service-owned CI credential tree", async () => {
    const result = await new NodeLocalRunnerSystemdCredentialLoader().load();

    expect(result).toBe(fixtureCredential);
  });

  it.skipIf(
    process.platform !== "linux" ||
      process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL_FAILURE === undefined,
  )("fails closed for the CI-provisioned adversarial tree", async () => {
    const expected = process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL_FAILURE;
    expect([
      "invalid_environment",
      "open_failed",
      "invalid_metadata",
      "credential_failed",
    ]).toContain(expected);

    const error = await new NodeLocalRunnerSystemdCredentialLoader()
      .load()
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(LocalRunnerSystemdCredentialLoadError);
    expect(error).toMatchObject({ code: expected });
    expect(Object.isFrozen(error)).toBe(true);
    expect("cause" in (error as object)).toBe(false);
    expect(JSON.stringify(error)).not.toMatch(
      /credentials\/socrates|runner-bearer|srt1/u,
    );
    expect((error as Error).message).not.toMatch(
      /credentials\/socrates|runner-bearer|srt1/u,
    );
  });
});
