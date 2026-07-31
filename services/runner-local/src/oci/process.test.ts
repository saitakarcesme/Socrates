import { describe, expect, it } from "vitest";

import { NodeProcessExecutor, ProcessExecutionError } from "./process";

describe("node process boundary", () => {
  it("executes discrete arguments without a shell", async () => {
    const processes = new NodeProcessExecutor({ environment: {} });
    const result = await processes.run({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write(process.argv[1])", "$(unsafe)"],
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("$(unsafe)");
  });

  it("kills output that crosses the byte boundary", async () => {
    const processes = new NodeProcessExecutor({ environment: {} });
    await expect(
      processes.run({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('x'.repeat(4096))"],
        timeoutMs: 5_000,
        maximumOutputBytes: 32,
      }),
    ).rejects.toMatchObject<Partial<ProcessExecutionError>>({
      code: "output_limit",
    });
  });
});
