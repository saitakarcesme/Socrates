import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runEngineSpike } from "./engine-spike";
import { supportedEngines, type EngineName } from "./types";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function engineOption(): EngineName {
  const value = option("--engine");
  const engine = supportedEngines.find((candidate) => candidate === value);
  if (!engine) {
    throw new Error(`--engine must be one of: ${supportedEngines.join(", ")}.`);
  }
  return engine;
}

function positiveIntegerOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) {
    throw new Error(`${name} must be an integer between 1 and 100.`);
  }
  return value;
}

async function main(): Promise<void> {
  const engine = engineOption();
  const image = option("--image");
  if (!image) throw new Error("--image with an immutable digest is required.");

  const evidence = await runEngineSpike({
    engine,
    image,
    allowDevelopmentHost: process.argv.includes("--allow-development-host"),
    latencySamples: positiveIntegerOption("--latency-samples", 30),
  });

  const evidenceRoot = resolve("spikes", "oci-engine", "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const outputPath = resolve(evidenceRoot, `${engine}-current-host.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });

  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      eligibleForNativeSelection: evidence.eligibleForNativeSelection,
      passedAdversarialGates: evidence.adversarial.filter((gate) => gate.passed)
        .length,
      adversarialGates: evidence.adversarial.length,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown spike error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
