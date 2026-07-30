import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["dist/server.js"], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    DATABASE_URL: "",
    MANUAL_RESEARCH_ENABLED: "false",
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error("Compiled API did not start within five seconds.")),
      5_000,
    );

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Compiled API exited before readiness with code ${code}.`),
      );
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const match = /localhost:(\d+)/.exec(chunk);

      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });

  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);

  if (!response.ok) {
    throw new Error(`Compiled API health check returned ${response.status}.`);
  }

  const body = await response.json();

  if (body.status !== "ok" || body.service !== "socrates-api") {
    throw new Error("Compiled API returned an invalid health response.");
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}
