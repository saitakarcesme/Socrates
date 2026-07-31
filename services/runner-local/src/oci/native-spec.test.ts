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
});
