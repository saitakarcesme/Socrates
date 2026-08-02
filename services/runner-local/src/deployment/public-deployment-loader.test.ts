import { describe, expect, it } from "vitest";

import {
  LocalRunnerPublicDeploymentLoadError,
  NodeLocalRunnerPublicDeploymentLoader,
} from "./index";

describe("NodeLocalRunnerPublicDeploymentLoader", () => {
  it("is an inert frozen production surface without input authority", () => {
    const loader = new NodeLocalRunnerPublicDeploymentLoader();

    expect(Object.isFrozen(loader)).toBe(true);
    expect(Reflect.ownKeys(loader)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(loader))).toEqual([
      "constructor",
      "load",
    ]);
    expect(NodeLocalRunnerPublicDeploymentLoader).toHaveLength(0);
    expect(loader.load).toHaveLength(0);
  });

  it.skipIf(process.platform === "linux")(
    "fails before filesystem access on unsupported hosts",
    async () => {
      const error = await new NodeLocalRunnerPublicDeploymentLoader()
        .load()
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(LocalRunnerPublicDeploymentLoadError);
      expect(error).toMatchObject({ code: "unsupported_host" });
      expect(Object.isFrozen(error)).toBe(true);
      expect("cause" in (error as object)).toBe(false);
      expect(JSON.stringify(error)).not.toContain("/etc/socrates");
      expect((error as Error).message).not.toContain("/etc/socrates");
    },
  );

  it.skipIf(
    process.platform !== "linux" ||
      process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT !== "1" ||
      process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT_FAILURE !== undefined,
  )("admits the fixed root-owned CI deployment tree", async () => {
    const result = await new NodeLocalRunnerPublicDeploymentLoader().load();

    expect(result.configuration).toMatchObject({
      version: "1",
      identity: {
        deploymentId: "runner-application-1",
        runnerId: "10000000-0000-4000-8000-000000000001",
      },
    });
    expect(result.trustedImages).toMatchObject({ version: "1" });
    expect(result.trustedImages.images).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.trustedImages.images)).toBe(true);
  });

  it.skipIf(
    process.platform !== "linux" ||
      process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT_FAILURE === undefined,
  )("fails closed for the CI-provisioned adversarial tree", async () => {
    const expected = process.env.SOCRATES_TEST_PUBLIC_DEPLOYMENT_FAILURE;
    expect([
      "open_failed",
      "invalid_metadata",
      "configuration_failed",
      "trusted_images_failed",
    ]).toContain(expected);

    const error = await new NodeLocalRunnerPublicDeploymentLoader()
      .load()
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(LocalRunnerPublicDeploymentLoadError);
    expect(error).toMatchObject({ code: expected });
    expect(Object.isFrozen(error)).toBe(true);
    expect("cause" in (error as object)).toBe(false);
    expect(JSON.stringify(error)).not.toContain("/etc/socrates");
    expect((error as Error).message).not.toContain("/etc/socrates");
  });
});
