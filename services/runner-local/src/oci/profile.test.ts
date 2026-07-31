import { describe, expect, it } from "vitest";

import { createSandboxOwnership } from "./identity";
import { buildCreateArguments } from "./profile";
import { fixtureIdentity, fixtureImage, fixtureProfile } from "./test-fixtures";
import {
  completeMaterializedSourceSnapshotRelease,
  issueMaterializedSourceSnapshot,
} from "../source/capability";

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
      fixtureImage.reference,
      "-e",
      "process.stdout.write('ok')",
    ]);
    expect(
      arguments_.slice(
        arguments_.indexOf("--entrypoint"),
        arguments_.indexOf("--entrypoint") + 2,
      ),
    ).toEqual(["--entrypoint", "/usr/local/bin/node"]);
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

  it("resolves only a live same-attempt source capability", () => {
    const ownership = createSandboxOwnership("deployment-a", fixtureIdentity);
    const source = issueMaterializedSourceSnapshot({
      path: "/runner/sources/source-owned/tree",
      deploymentId: "deployment-a",
      identity: fixtureIdentity,
      digest: `sha256:${"a".repeat(64)}`,
      archiveBytes: 1_024,
      expandedBytes: 12,
      entryCount: 2,
    });
    const input = {
      ownership,
      image: fixtureImage,
      profile: fixtureProfile,
      command: { executable: "/bin/true", arguments: [] },
      source,
      deploymentId: "deployment-a",
      identity: fixtureIdentity,
    } as const;

    expect(buildCreateArguments(input)).toContain(
      "type=bind,src=/runner/sources/source-owned/tree,dst=/socrates/source,rro,bind-propagation=rprivate",
    );
    expect(() =>
      buildCreateArguments({
        ...input,
        identity: { ...fixtureIdentity, fence: fixtureIdentity.fence + 1 },
      }),
    ).toThrow("does not belong");

    completeMaterializedSourceSnapshotRelease(source);
    expect(() => buildCreateArguments(input)).toThrow("does not belong");
  });
});
