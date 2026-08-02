import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { NodeLocalRunnerDispatchObserver } from "../src/observation/node-dispatch-observer";

const maximumCaptureBytes = 2_048;
const childFlag = "SOCRATES_TEST_OBSERVATION_CHILD";
const expected =
  '{"schema":"socrates.local-runner.dispatch-observation.v1","state":"idle"}\n';

async function collect(
  child: ChildProcessWithoutNullStreams,
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maximumCaptureBytes) {
        child.kill();
        reject(new Error("Native observation output exceeded its limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks, total)));
  });
}

async function validateParent(): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, [childFlag]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.end();
  const closed = new Promise<
    Readonly<{ code: number | null; signal: string | null }>
  >((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const [stdout, stderr, exit] = await Promise.all([
    collect(child, child.stdout),
    collect(child, child.stderr),
    closed,
  ]);

  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.equal(stdout.byteLength, 0);
  assert.equal(stderr.toString("utf8"), expected);
  assert.equal(stderr.at(-1), 0x0a);
  assert.equal(stderr.subarray(0, -1).includes(0x0a), false);
  process.stdout.write(
    `${JSON.stringify({
      schema: "socrates.runner-observation-native-evidence.v1",
      childExit: "success",
      records: 1,
      stderrBytes: stderr.byteLength,
      stdoutBytes: stdout.byteLength,
    })}\n`,
  );
}

async function validateChild(): Promise<void> {
  const observer = new NodeLocalRunnerDispatchObserver();
  await observer.observe(Object.freeze({ state: "idle" }));
}

if (process.env[childFlag] === "1") {
  await validateChild();
} else {
  await validateParent();
}
