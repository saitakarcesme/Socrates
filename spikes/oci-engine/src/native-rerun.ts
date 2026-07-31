import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildNativeComparison,
  optionalNativeEngines,
  requiredNativeEngines,
} from "./native-comparison";
import { runEngineSpike } from "./engine-spike";

import type { EngineName, NativeEngineOutcome } from "./types";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
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

function sessionId(recordedAt: string): string {
  return `${recordedAt.replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

async function main(): Promise<void> {
  const image = option("--image");
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error("--image must be an immutable name@sha256:digest.");
  }
  const latencySamples = positiveIntegerOption("--latency-samples", 30);
  const recordedAt = new Date().toISOString();
  const currentSessionId = sessionId(recordedAt);
  const evidenceRoot = resolve(
    "spikes",
    "oci-engine",
    "evidence",
    "native",
    currentSessionId,
  );
  await mkdir(evidenceRoot, { recursive: true });

  const engines: readonly EngineName[] = [
    ...requiredNativeEngines,
    ...optionalNativeEngines,
  ];
  const outcomes: NativeEngineOutcome[] = [];
  for (const engine of engines) {
    try {
      const evidence = await runEngineSpike({
        engine,
        image,
        allowDevelopmentHost: false,
        latencySamples,
      });
      const evidenceFile = `${engine}.json`;
      await writeFile(
        resolve(evidenceRoot, evidenceFile),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      outcomes.push({ engine, evidenceFile, evidence });
    } catch (error) {
      outcomes.push({ engine, failureCode: "execution-error" });
      const message =
        error instanceof Error ? error.message : "unknown execution error";
      process.stderr.write(`${engine}: ${message}\n`);
    }
  }

  const comparison = buildNativeComparison({
    sessionId: currentSessionId,
    recordedAt,
    image,
    outcomes,
  });
  const comparisonPath = resolve(evidenceRoot, "comparison.json");
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({
      comparisonPath,
      readyForArchitectureReview: comparison.readyForArchitectureReview,
      gates: comparison.gates,
    })}\n`,
  );
  if (!comparison.readyForArchitectureReview) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown native rerun error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
