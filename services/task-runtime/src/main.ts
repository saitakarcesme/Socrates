import type { Readable, Writable } from "node:stream";

import { TaskRuntimeEngine } from "./engine";
import { NodeRuntimeProcessExecutor } from "./process";
import { TaskRuntimeProgram } from "./program";
import { NodeRuntimeFrameWriter } from "./writer";
import { RuntimeWorkspacePreparer } from "./workspace";

export async function runTaskRuntime(input: {
  arguments: readonly string[];
  stdin: Readable;
  stdout: Writable;
  buildDigest: string;
}): Promise<number> {
  const writer = new NodeRuntimeFrameWriter(input.stdout);
  const program = new TaskRuntimeProgram(
    new TaskRuntimeEngine(
      new RuntimeWorkspacePreparer(),
      new NodeRuntimeProcessExecutor(),
    ),
    input.buildDigest,
  );

  let exitCode: number;
  if (input.arguments.length === 1 && input.arguments[0] === "--handshake") {
    program.handshake(writer);
    exitCode = 0;
  } else if (input.arguments.length === 0) {
    const status = await program.execute(input.stdin, writer);
    exitCode = status === "succeeded" ? 0 : 1;
  } else {
    exitCode = 64;
  }
  await writer.finish();
  return exitCode;
}
