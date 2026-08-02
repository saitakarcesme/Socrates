import { canonicalJson } from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import {
  fixtureApplicationConfiguration,
  fixtureCredential,
  fixtureTrustedImages,
} from "../platform/test-fixtures";
import {
  admitLocalRunnerConfigurationBytes,
  admitLocalRunnerCredentialBytes,
  admitLocalRunnerTrustedImageBytes,
} from "./bytes";
import {
  loadLocalRunnerDeploymentInputs,
  type LocalRunnerDeploymentLoaderOperations,
} from "./deployment-loader-core";
import {
  LocalRunnerDeploymentLoadError,
  type LocalRunnerDeploymentLoadErrorCode,
} from "./deployment-loader-contracts";

const encoder = new TextEncoder();

function admittedPublicInputs() {
  return Object.freeze({
    configuration: admitLocalRunnerConfigurationBytes(
      encoder.encode(canonicalJson(fixtureApplicationConfiguration())),
    ),
    trustedImages: admitLocalRunnerTrustedImageBytes(
      encoder.encode(canonicalJson(fixtureTrustedImages())),
    ),
  });
}

const admittedCredential = admitLocalRunnerCredentialBytes(
  encoder.encode(fixtureCredential),
);

type FakeOptions = Readonly<{
  publicFailure?: "reject" | "throw";
  credentialFailure?: "reject" | "throw";
  publicInputs?: ReturnType<typeof admittedPublicInputs>;
}>;

function fakeOperations(options: FakeOptions = {}) {
  const events: string[] = [];
  let publicCalls = 0;
  let credentialCalls = 0;
  const operations: LocalRunnerDeploymentLoaderOperations = {
    loadPublicInputs: () => {
      publicCalls += 1;
      events.push("public");
      if (options.publicFailure === "throw") {
        throw new Error("private public path and document");
      }
      if (options.publicFailure === "reject") {
        return Promise.reject(new Error("private public path and document"));
      }
      return Promise.resolve(options.publicInputs ?? admittedPublicInputs());
    },
    loadCredential: () => {
      credentialCalls += 1;
      events.push("credential");
      if (options.credentialFailure === "throw") {
        throw new Error(`private credential ${fixtureCredential}`);
      }
      if (options.credentialFailure === "reject") {
        return Promise.reject(
          new Error(`private credential ${fixtureCredential}`),
        );
      }
      return Promise.resolve(admittedCredential);
    },
  };
  return {
    events,
    operations,
    publicCalls: () => publicCalls,
    credentialCalls: () => credentialCalls,
  };
}

async function expectCode(
  operation: Promise<unknown>,
  code: LocalRunnerDeploymentLoadErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LocalRunnerDeploymentLoadError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  expect(JSON.stringify(error)).not.toMatch(
    /private|configuration|trusted|credentials|srt1/u,
  );
  expect((error as Error).message).not.toMatch(
    /private|configuration|trusted|credentials|srt1/u,
  );
  return error as LocalRunnerDeploymentLoadError;
}

describe("loadLocalRunnerDeploymentInputs", () => {
  it("joins one complete public snapshot before one credential", async () => {
    const publicInputs = admittedPublicInputs();
    const fake = fakeOperations({ publicInputs });

    const result = await loadLocalRunnerDeploymentInputs(fake.operations);

    expect(fake.events).toEqual(["public", "credential"]);
    expect(fake.publicCalls()).toBe(1);
    expect(fake.credentialCalls()).toBe(1);
    expect(result).toEqual({
      configuration: fixtureApplicationConfiguration(),
      trustedImages: fixtureTrustedImages(),
      credential: fixtureCredential,
    });
    expect(result.configuration).toBe(publicInputs.configuration);
    expect(result.trustedImages).toBe(publicInputs.trustedImages);
    expect(result.credential).toBe(admittedCredential);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.trustedImages.images)).toBe(true);
  });

  it.each(["throw", "reject"] as const)(
    "prevents credential access after a public %s",
    async (publicFailure) => {
      const fake = fakeOperations({ publicFailure });
      await expectCode(
        loadLocalRunnerDeploymentInputs(fake.operations),
        "public_inputs_failed",
      );
      expect(fake.events).toEqual(["public"]);
      expect(fake.publicCalls()).toBe(1);
      expect(fake.credentialCalls()).toBe(0);
    },
  );

  it.each(["throw", "reject"] as const)(
    "normalizes a credential %s only after public success",
    async (credentialFailure) => {
      const fake = fakeOperations({ credentialFailure });
      await expectCode(
        loadLocalRunnerDeploymentInputs(fake.operations),
        "credential_failed",
      );
      expect(fake.events).toEqual(["public", "credential"]);
      expect(fake.publicCalls()).toBe(1);
      expect(fake.credentialCalls()).toBe(1);
    },
  );

  it("reads public properties once in fixed order after credential success", async () => {
    const values = admittedPublicInputs();
    const events: string[] = [];
    const publicInputs = {
      get configuration() {
        events.push("configuration");
        return values.configuration;
      },
      get trustedImages() {
        events.push("trustedImages");
        return values.trustedImages;
      },
    };
    const operations: LocalRunnerDeploymentLoaderOperations = {
      loadPublicInputs: async () => {
        events.push("public");
        return publicInputs;
      },
      loadCredential: async () => {
        events.push("credential");
        return admittedCredential;
      },
    };

    await loadLocalRunnerDeploymentInputs(operations);
    expect(events).toEqual([
      "public",
      "credential",
      "configuration",
      "trustedImages",
    ]);
  });

  it.each(["configuration", "trustedImages"] as const)(
    "normalizes throwing %s projection without exposing its cause",
    async (property) => {
      const values = admittedPublicInputs();
      const publicInputs = Object.defineProperties(
        {},
        {
          configuration: {
            enumerable: true,
            get() {
              if (property === "configuration") {
                throw new Error("private configuration path");
              }
              return values.configuration;
            },
          },
          trustedImages: {
            enumerable: true,
            get() {
              if (property === "trustedImages") {
                throw new Error("private trusted document");
              }
              return values.trustedImages;
            },
          },
        },
      ) as ReturnType<typeof admittedPublicInputs>;
      const fake = fakeOperations({ publicInputs });

      await expectCode(
        loadLocalRunnerDeploymentInputs(fake.operations),
        "composition_failed",
      );
      expect(fake.events).toEqual(["public", "credential"]);
    },
  );

  it("creates an isolated owner for every explicit call", async () => {
    const fake = fakeOperations();

    const first = await loadLocalRunnerDeploymentInputs(fake.operations);
    const second = await loadLocalRunnerDeploymentInputs(fake.operations);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(fake.events).toEqual([
      "public",
      "credential",
      "public",
      "credential",
    ]);
    expect(fake.publicCalls()).toBe(2);
    expect(fake.credentialCalls()).toBe(2);
  });
});
