import { runTaskRuntime } from "./main";

declare const __SOCRATES_RUNTIME_BUILD_DIGEST__: string;

try {
  process.exitCode = await runTaskRuntime({
    arguments: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    buildDigest: __SOCRATES_RUNTIME_BUILD_DIGEST__,
  });
} catch {
  process.exitCode = 1;
}
