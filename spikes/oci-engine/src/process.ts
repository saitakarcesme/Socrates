import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { CommandResult } from "./types";

const maximumOutputBytes = 256 * 1_024;

export async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const startedAt = performance.now();
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;

  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maximumOutputBytes) {
      child.kill("SIGKILL");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const outcome = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => clearTimeout(timeout));

  return {
    command,
    args,
    ...outcome,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim(),
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut,
  };
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await runCommand(command, ["--version"], 5_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
