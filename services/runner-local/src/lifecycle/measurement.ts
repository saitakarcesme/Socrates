import {
  canonicalDecimalSchema,
  type RunnerExecutionV1,
} from "@socrates/contracts";
import { canonicalJson } from "@socrates/runtime-protocol";

import { runnerEventDraft, type RunnerEventDraft } from "./draft";

export class RuntimeMeasurementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeMeasurementError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function runtimeMeasurementDraft(input: {
  chunks: readonly Uint8Array[];
  measurement: RunnerExecutionV1["task"]["measurement"];
}): RunnerEventDraft {
  const size = input.chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  if (size > input.measurement.result.maximumBytes) {
    throw new RuntimeMeasurementError(
      "Runtime measurement exceeds the frozen result byte limit.",
    );
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of input.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new RuntimeMeasurementError(
      "Runtime measurement is not valid UTF-8.",
      { cause },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeMeasurementError(
      "Runtime measurement is not valid JSON.",
      { cause },
    );
  }
  const record = object(value);
  if (
    !record ||
    Object.keys(record).sort().join(",") !== "schema,value" ||
    record["schema"] !== input.measurement.result.schema
  ) {
    throw new RuntimeMeasurementError(
      "Runtime measurement does not match the frozen result schema.",
    );
  }
  const amount = canonicalDecimalSchema.safeParse(record["value"]);
  if (!amount.success) {
    throw new RuntimeMeasurementError(
      "Runtime measurement value is not a canonical decimal.",
      { cause: amount.error },
    );
  }
  const canonical = {
    schema: input.measurement.result.schema,
    value: amount.data,
  };
  if (canonicalJson(canonical) !== text) {
    throw new RuntimeMeasurementError(
      "Runtime measurement JSON is not canonical.",
    );
  }
  return runnerEventDraft({
    type: "measurement.recorded",
    payload: {
      metricDefinitionId: input.measurement.metricDefinitionId,
      amount: amount.data,
      unit: input.measurement.unit,
      sampleCount: 1,
    },
  });
}
