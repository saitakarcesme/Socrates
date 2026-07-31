import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type BuildManifest = Readonly<{
  schema: string;
  abi: string;
  runtimeBuildDigest: string;
  bundleDigest: string;
  entrypoint: Readonly<{
    executable: string;
    arguments: readonly string[];
  }>;
}>;

describe("task runtime build", () => {
  it("emits a bundle whose embedded identity and digest match the manifest", async () => {
    const root = join(import.meta.dirname, "..");
    const bundle = await readFile(join(root, "dist/task-runtime.mjs"));
    const manifest = JSON.parse(
      await readFile(join(root, "dist/build-identity.json"), "utf8"),
    ) as BuildManifest;
    const bundleDigest = `sha256:${createHash("sha256")
      .update(bundle)
      .digest("hex")}`;

    expect(manifest).toMatchObject({
      schema: "socrates.task-runtime.build.v1",
      abi: "socrates.task-runtime.v1",
      entrypoint: {
        executable: "/usr/local/bin/node",
        arguments: ["/opt/socrates/task-runtime.mjs"],
      },
    });
    expect(manifest.runtimeBuildDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(bundleDigest).toBe(manifest.bundleDigest);
    expect(bundle.toString("utf8")).toContain(manifest.runtimeBuildDigest);
    expect(bundle.toString("utf8")).not.toContain(`sha256:${"0".repeat(64)}`);
  });
});
