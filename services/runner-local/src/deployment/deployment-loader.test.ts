import { describe, expect, it } from "vitest";

import { fixtureCredential } from "../platform/test-fixtures";
import {
  LocalRunnerDeploymentLoadError,
  NodeLocalRunnerDeploymentLoader,
} from "./index";

describe("NodeLocalRunnerDeploymentLoader", () => {
  it("is an inert frozen production surface without input authority", () => {
    const loader = new NodeLocalRunnerDeploymentLoader();

    expect(Object.isFrozen(loader)).toBe(true);
    expect(Reflect.ownKeys(loader)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(loader))).toEqual([
      "constructor",
      "load",
    ]);
    expect(NodeLocalRunnerDeploymentLoader).toHaveLength(0);
    expect(loader.load).toHaveLength(0);
  });

  it.skipIf(process.platform === "linux")(
    "normalizes the public loader before credential access on unsupported hosts",
    async () => {
      const error = await new NodeLocalRunnerDeploymentLoader()
        .load()
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(LocalRunnerDeploymentLoadError);
      expect(error).toMatchObject({ code: "public_inputs_failed" });
      expect(Object.isFrozen(error)).toBe(true);
      expect("cause" in (error as object)).toBe(false);
      expect(JSON.stringify(error)).not.toMatch(
        /etc|credentials|runner-bearer/u,
      );
      expect((error as Error).message).not.toMatch(
        /etc|credentials|runner-bearer/u,
      );
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT !== "1" ||
      process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL !== "1" ||
      process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT_FAILURE !== undefined ||
      process.env.SOCRATES_TEST_SYSTEMD_CREDENTIAL_FAILURE !== undefined,
  )("joins the two fixed CI deployment boundaries", async () => {
    const result = await new NodeLocalRunnerDeploymentLoader().load();

    expect(result.configuration).toMatchObject({
      version: "1",
      identity: {
        deploymentId: "runner-application-1",
        runnerId: "10000000-0000-4000-8000-000000000001",
      },
    });
    expect(result.trustedImages).toMatchObject({ version: "1" });
    expect(result.trustedImages.images).toHaveLength(1);
    expect(result.credential).toBe(fixtureCredential);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.trustedImages.images)).toBe(true);
  });
});
