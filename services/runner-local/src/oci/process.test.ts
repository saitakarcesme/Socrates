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

  it("writes bounded binary stdin without a shell or text conversion", async () => {
    const input = Uint8Array.from([0, 1, 2, 255]);
    const result = await new NodeProcessExecutor({ environment: {} }).run({
      executable: process.execPath,
      arguments: [
        "-e",
        "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)))",
      ],
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
      stdin: input,
      maximumInputBytes: input.byteLength,
    });

    expect(result.stdoutBytes).toEqual(input);
    expect(result.stderrBytes).toHaveLength(0);
  });

  it("rejects stdin that exceeds its explicit input bound", async () => {
    await expect(
      new NodeProcessExecutor({ environment: {} }).run({
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
        stdin: Uint8Array.from([1, 2]),
        maximumInputBytes: 1,
      }),
    ).rejects.toThrow(/input exceeds/u);
  });
});
