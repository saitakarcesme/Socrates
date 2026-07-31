import { createReadStream } from "node:fs";

import { runTaskRuntime } from "./main";

declare const __SOCRATES_RUNTIME_BUILD_DIGEST__: string;

try {
  const arguments_ = process.argv.slice(2);
  process.exitCode = await runTaskRuntime({
    arguments: arguments_,
    stdin:
      arguments_.length === 0
        ? createReadStream("/socrates/request.bin")
        : process.stdin,
    stdout: process.stdout,
    buildDigest: __SOCRATES_RUNTIME_BUILD_DIGEST__,
  });
} catch {
  process.exitCode = 1;
}
