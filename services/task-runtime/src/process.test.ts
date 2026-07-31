import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeRuntimeProcessExecutor, RuntimeProcessError } from "./process";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "socrates-runtime-"));
  roots.push(root);
  const path = join(root, "workspace");
  await mkdir(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("task runtime process boundary", () => {
  it.skipIf(process.platform === "win32")(
    "executes exact argv with no shell and captures binary output",
    async () => {
      const cwd = await workspace();
      const output: Array<{ stream: string; bytes: Uint8Array }> = [];
      const result = await new NodeRuntimeProcessExecutor(cwd).run({
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write(Buffer.from([0,1,255]));process.stderr.write('e')",
        ],
        workingDirectory: "/workspace",
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
        environment: { PATH: process.env["PATH"] ?? "" },
        onOutput: (stream, bytes) => output.push({ stream, bytes }),
      });

      expect(result).toMatchObject({
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
        outputBytes: 4,
      });
      expect(output.map(({ stream }) => stream).sort()).toEqual([
        "stderr",
        "stdout",
      ]);
    },
  );

  it("rejects cwd escape before spawning", async () => {
    await expect(
      new NodeRuntimeProcessExecutor().run({
        executable: "/bin/true",
        arguments: [],
        workingDirectory: "/tmp",
        timeoutMs: 1_000,
        maximumOutputBytes: 1,
        environment: {},
        onOutput: () => undefined,
      }),
    ).rejects.toMatchObject<Partial<RuntimeProcessError>>({
      code: "invalid_request",
    });
  });
});
