import type {
  ExperimentDetailResource,
  MetricDirection,
} from "@socrates/contracts";

type MetricValue = {
  amount: string;
  unit: string;
};

function parseDecimal(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");

  return {
    coefficient: BigInt(`${negative ? "-" : ""}${integer}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimals(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const alignedA = a.coefficient * 10n ** BigInt(scale - a.scale);
  const alignedB = b.coefficient * 10n ** BigInt(scale - b.scale);

  return alignedA < alignedB ? -1 : alignedA > alignedB ? 1 : 0;
}

export function formatMetric(value: MetricValue | null | undefined) {
  return value ? `${value.amount} ${value.unit}` : "Not measured";
}

export function selectBestMetric(
  baseline: MetricValue | null,
  experiments: ExperimentDetailResource[],
  direction: MetricDirection,
): MetricValue | null {
  const candidates = [
    ...(baseline ? [baseline] : []),
    ...experiments.flatMap((experiment) =>
      experiment.observations
        .filter((observation) => observation.kind === "after")
        .map((observation) => observation.value),
    ),
  ];

  return candidates.reduce<MetricValue | null>((best, candidate) => {
    if (!best) {
      return candidate;
    }

    const comparison = compareDecimals(candidate.amount, best.amount);
    const isBetter = direction === "maximize" ? comparison > 0 : comparison < 0;
    return isBetter ? candidate : best;
  }, null);
}

export function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
  fallbackMs?: number,
) {
  const elapsed =
    startedAt && completedAt
      ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
      : fallbackMs;

  if (elapsed === undefined || elapsed < 0) {
    return "Not started";
  }

  if (elapsed < 60_000) {
    return `${Math.max(1, Math.round(elapsed / 1_000))}s`;
  }

  if (elapsed < 3_600_000) {
    return `${Math.round(elapsed / 60_000)}m`;
  }

  return `${(elapsed / 3_600_000).toFixed(1)}h`;
}
