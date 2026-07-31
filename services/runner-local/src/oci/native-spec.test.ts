import { describe, expect, it } from "vitest";

import {
  parseNativeSpec,
  SandboxInspectionError,
  verifyNativeSpec,
} from "./native-spec";
import { fixtureNativeInspection, fixtureProfile } from "./test-fixtures";

describe("native OCI spec verification", () => {
  it("accepts the exact fixed profile", () => {
    expect(() =>
      verifyNativeSpec(
        parseNativeSpec(fixtureNativeInspection()),
        fixtureProfile,
      ),
    ).not.toThrow();
  });

  it("normalizes native Go JSON capability casing", () => {
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const process = parsed["process"] as Record<string, unknown>;
    const capabilities = process["capabilities"] as Record<string, unknown>;
    delete process["capabilities"];
    process["Capabilities"] = Object.fromEntries(
      Object.entries(capabilities).map(([name, value]) => [
        `${name[0]?.toUpperCase()}${name.slice(1)}`,
        value,
      ]),
    );
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).not.toThrow();
  });

  it("rejects host environment inheritance", () => {
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const process = parsed["process"] as Record<string, unknown>;
    process["env"] = ["SOCRATES_SANDBOX=1", "GITHUB_TOKEN=not-a-secret"];
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );
  });

  it.each([
    ["privilege escalation", { process: { noNewPrivileges: false } }],
    ["writable root", { root: { readonly: false } }],
    [
      "host bind",
      {
        mounts: [
          {
            destination: "/host",
            type: "bind",
            source: "/",
            options: ["rbind", "rw"],
          },
        ],
      },
    ],
    ["missing namespaces", { linux: { namespaces: [] } }],
  ])("rejects %s", (_name, override) => {
    expect(() =>
      verifyNativeSpec(
        parseNativeSpec(fixtureNativeInspection(override)),
        fixtureProfile,
      ),
    ).toThrow(SandboxInspectionError);
  });

  it("rejects malformed or absent native specs", () => {
    expect(() => parseNativeSpec("not-json")).toThrow(SandboxInspectionError);
    expect(() => parseNativeSpec("[]")).toThrow("omitted Spec");
  });

  it("admits only rootless nerdctl-owned hostname metadata binds", () => {
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const mounts = parsed["mounts"] as unknown[];
    mounts.push({
      destination: "/etc/hosts",
      source:
        "/home/runner/.local/share/nerdctl/containers/default/owned/hosts",
      type: "bind",
      options: ["rbind", "rw"],
    });
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).not.toThrow();

    (mounts.at(-1) as Record<string, unknown>)["source"] = "/etc/hosts";
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );
  });
});
