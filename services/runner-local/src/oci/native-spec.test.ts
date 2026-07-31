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

  it("accepts nerdctl's explicit empty capability object", () => {
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const process = parsed["process"] as Record<string, unknown>;
    process["Capabilities"] = {};
    delete process["capabilities"];
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).not.toThrow();
  });

  it("rejects an absent or partially specified capability object", () => {
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const process = parsed["process"] as Record<string, unknown>;
    delete process["capabilities"];
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );
    process["Capabilities"] = { effective: [] };
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );
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

  it("admits exactly one expected recursive read-only source bind", () => {
    const sourcePath = "/runner/sources/source-owned/tree";
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const mounts = parsed["mounts"] as unknown[];
    mounts.push({
      destination: "/socrates/source",
      source: sourcePath,
      type: "bind",
      options: ["rbind", "rprivate", "ro"],
    });

    expect(() =>
      verifyNativeSpec(parsed, fixtureProfile, sourcePath),
    ).not.toThrow();
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );

    (mounts.at(-1) as Record<string, unknown>)["options"] = [
      "rbind",
      "rprivate",
      "rw",
    ];
    expect(() => verifyNativeSpec(parsed, fixtureProfile, sourcePath)).toThrow(
      SandboxInspectionError,
    );
  });

  it("admits exactly one expected recursive read-only request bind", () => {
    const requestPath = "/runner/sources/source-owned/request.bin";
    const parsed = parseNativeSpec(fixtureNativeInspection());
    const mounts = parsed["mounts"] as unknown[];
    mounts.push({
      destination: "/socrates/request.bin",
      source: requestPath,
      type: "bind",
      options: ["rbind", "rprivate", "ro"],
    });

    expect(() =>
      verifyNativeSpec(parsed, fixtureProfile, undefined, requestPath),
    ).not.toThrow();
    expect(() => verifyNativeSpec(parsed, fixtureProfile)).toThrow(
      SandboxInspectionError,
    );

    (mounts.at(-1) as Record<string, unknown>)["source"] =
      "/runner/foreign/request.bin";
    expect(() =>
      verifyNativeSpec(parsed, fixtureProfile, undefined, requestPath),
    ).toThrow(SandboxInspectionError);
  });
});
