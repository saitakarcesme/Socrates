import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeProcessExecutor, ProcessExecutionError } from "./process";

describe("node process boundary", () => {
  it("executes discrete arguments without a shell", async () => {
    const processes = new NodeProcessExecutor();
    const result = await processes.run({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write(process.argv[1])", "$(unsafe)"],
      environment: {},
      workingDirectory: process.cwd(),
      timeoutMs: 5_000,
      maximumOutputBytes: 1_024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("$(unsafe)");
  });

  it("kills output that crosses the byte boundary", async () => {
    const processes = new NodeProcessExecutor();
    await expect(
      processes.run({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('x'.repeat(4096))"],
        environment: {},
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        maximumOutputBytes: 32,
      }),
    ).rejects.toMatchObject<Partial<ProcessExecutionError>>({
      code: "output_limit",
    });
  });

  it("writes bounded binary stdin without a shell or text conversion", async () => {
    const input = Uint8Array.from([0, 1, 2, 255]);
    const result = await new NodeProcessExecutor().run({
      executable: process.execPath,
      arguments: [
        "-e",
        "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)))",
      ],
      environment: {},
      workingDirectory: process.cwd(),
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
      new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        environment: {},
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
        stdin: Uint8Array.from([1, 2]),
        maximumInputBytes: 1,
      }),
    ).rejects.toThrow(/input exceeds/u);
  });

  it("passes exactly the request environment without ambient inheritance", async () => {
    const name = "SOCRATES_AMBIENT_SHOULD_NOT_LEAK";
    const previous = process.env[name];
    process.env[name] = "ambient";
    try {
      const result = await new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        environment: { SOCRATES_EXACT: "admitted" },
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        maximumOutputBytes: 16_384,
      });

      expect(JSON.parse(result.stdout)).toMatchObject({
        SOCRATES_EXACT: "admitted",
      });
      expect(JSON.parse(result.stdout)).not.toHaveProperty(name);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("rejects accessors without invoking an environment getter", async () => {
    let reads = 0;
    const environment = Object.defineProperty({}, "SECRET", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "not-admitted";
      },
    }) as Readonly<Record<string, string>>;

    await expect(
      new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        environment,
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
      }),
    ).rejects.toThrow("Process environment is invalid.");
    expect(reads).toBe(0);
  });

  it("rejects inherited process environment authority", async () => {
    const environment = Object.create({ HOME: "/ambient" }) as Record<
      string,
      string
    >;
    environment.SOCRATES_EXACT = "admitted";

    await expect(
      new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        environment,
        workingDirectory: process.cwd(),
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
      }),
    ).rejects.toThrow("Process environment is invalid.");
  });

  it("uses only the request working directory", async () => {
    const workingDirectory = await mkdtemp(
      join(tmpdir(), "socrates-process-cwd-"),
    );
    try {
      const result = await new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write(process.cwd())"],
        environment: {},
        workingDirectory,
        timeoutMs: 5_000,
        maximumOutputBytes: 4_096,
      });
      expect(result.stdout.toLowerCase()).toBe(workingDirectory.toLowerCase());
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a relative working directory before spawn", async () => {
    await expect(
      new NodeProcessExecutor().run({
        executable: process.execPath,
        arguments: ["-e", "process.exit(0)"],
        environment: {},
        workingDirectory: ".",
        timeoutMs: 5_000,
        maximumOutputBytes: 1_024,
      }),
    ).rejects.toThrow("Process working directory is invalid.");
  });
});
