import type { LatencySummary } from "./types";

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    throw new RangeError("At least one latency sample is required.");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const medianIndex = Math.floor((ordered.length - 1) * 0.5);
  const p95Index = Math.ceil(ordered.length * 0.95) - 1;
  return {
    samples: ordered.length,
    medianMs: ordered[medianIndex]!,
    p95Ms: ordered[p95Index]!,
    maximumMs: ordered.at(-1)!,
  };
}
