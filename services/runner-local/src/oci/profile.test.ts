import { describe, expect, it } from "vitest";

import { createSandboxOwnership } from "./identity";
import { buildCreateArguments } from "./profile";
import { fixtureIdentity, fixtureImage, fixtureProfile } from "./test-fixtures";

describe("sandbox create profile", () => {
  it("builds one closed, no-shell nerdctl argument vector", () => {
    const ownership = createSandboxOwnership("deployment-a", fixtureIdentity);
    const arguments_ = buildCreateArguments({
      ownership,
      image: fixtureImage,
      profile: fixtureProfile,
      command: {
        executable: "/usr/local/bin/node",
        arguments: ["-e", "process.stdout.write('ok')"],
      },
    });

    expect(arguments_[0]).toBe("create");
    expect(arguments_).toContain("apparmor=socrates-sandbox");
    expect(arguments_).toContain("no-new-privileges");
    expect(arguments_).toContain("--pull");
    expect(arguments_).toContain("never");
    expect(arguments_).toContain("--log-driver");
    expect(arguments_).toContain("none");
    expect(arguments_).toContain(fixtureImage.reference);
    expect(arguments_.slice(-3)).toEqual([
      "/usr/local/bin/node",
      "-e",
      "process.stdout.write('ok')",
    ]);
    expect(arguments_).not.toContain("/bin/sh");
  });

  it("rejects non-absolute executables and invalid resource bounds", () => {
    const ownership = createSandboxOwnership("deployment-a", fixtureIdentity);
    expect(() =>
      buildCreateArguments({
        ownership,
        image: fixtureImage,
        profile: fixtureProfile,
        command: { executable: "node", arguments: [] },
      }),
    ).toThrow("normalized absolute path");
    expect(() =>
      buildCreateArguments({
        ownership,
        image: fixtureImage,
        profile: { ...fixtureProfile, maximumPids: 0 },
        command: { executable: "/bin/true", arguments: [] },
      }),
    ).toThrow("maximumPids");
  });
});
