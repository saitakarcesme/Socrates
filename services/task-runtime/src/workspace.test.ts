import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeWorkspaceError, RuntimeWorkspacePreparer } from "./workspace";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "socrates-runtime-copy-"));
  roots.push(root);
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  await mkdir(join(source, "nested"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(source, "nested", "value.txt"), "value");
  return { source, workspace };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime workspace preparer", () => {
  it("copies a bounded regular tree into an empty workspace", async () => {
    const { source, workspace } = await fixture();
    const result = await new RuntimeWorkspacePreparer(
      source,
      workspace,
    ).prepare({
      maximumBytes: 1_024,
      maximumEntries: 8,
    });

    expect(result).toEqual({ copiedBytes: 5, entryCount: 2 });
    await expect(
      readFile(join(workspace, "nested", "value.txt"), "utf8"),
    ).resolves.toBe("value");
  });

  it("clears partial copies after a byte-limit failure", async () => {
    const { source, workspace } = await fixture();
    await expect(
      new RuntimeWorkspacePreparer(source, workspace).prepare({
        maximumBytes: 4,
        maximumEntries: 8,
      }),
    ).rejects.toMatchObject<Partial<RuntimeWorkspaceError>>({
      code: "invalid_limit",
    });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it("refuses a pre-populated workspace", async () => {
    const { source, workspace } = await fixture();
    await writeFile(join(workspace, "foreign"), "keep");

    await expect(
      new RuntimeWorkspacePreparer(source, workspace).prepare({
        maximumBytes: 1_024,
        maximumEntries: 8,
      }),
    ).rejects.toMatchObject<Partial<RuntimeWorkspaceError>>({
      code: "workspace_not_empty",
    });
    await expect(readFile(join(workspace, "foreign"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});
