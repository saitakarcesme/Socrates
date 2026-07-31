import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  canonicalSourcePath,
  SourcePathError,
  SourcePathRegistry,
} from "./path-policy";

const limits = {
  maximumPathBytes: 128,
  maximumComponentBytes: 32,
  maximumPathDepth: 8,
} as const;

describe("source path policy", () => {
  it("accepts one normalized portable relative path", () => {
    expect(canonicalSourcePath("src/core/index.ts", "file", limits)).toBe(
      "src/core/index.ts",
    );
    expect(canonicalSourcePath("empty/", "directory", limits)).toBe("empty");
  });

  it.each([
    "/absolute",
    "../escape",
    "src/../escape",
    "C:/drive",
    "src\\windows",
    "src//empty",
    "src/.",
    "src/con",
    "src/trailing.",
    "src/trailing ",
    "src/key:value",
    "src/\u0000control",
    "cafe\u0301.txt",
  ])("rejects non-portable path %j", (path) => {
    expect(() => canonicalSourcePath(path, "file", limits)).toThrow(
      SourcePathError,
    );
  });

  it("rejects duplicate, case-colliding, and ancestor-conflicting entries", () => {
    const duplicate = new SourcePathRegistry();
    duplicate.register("src/index.ts", "file");
    expect(() => duplicate.register("src/index.ts", "file")).toThrow(
      SourcePathError,
    );

    const folded = new SourcePathRegistry();
    folded.register("README.md", "file");
    expect(() => folded.register("readme.md", "file")).toThrow(SourcePathError);

    const ancestor = new SourcePathRegistry();
    ancestor.register("src/index.ts", "file");
    expect(() => ancestor.register("src", "file")).toThrow(SourcePathError);
  });

  it("never admits generated traversal components", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/u), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.boolean(),
        (components, traversalFirst) => {
          const path = traversalFirst
            ? ["..", ...components].join("/")
            : [...components, ".."].join("/");
          expect(() => canonicalSourcePath(path, "file", limits)).toThrow(
            SourcePathError,
          );
        },
      ),
      { numRuns: 250 },
    );
  });
});
