import { runnerExecutionV1Schema } from "@socrates/contracts";
import { describe, expect, it } from "vitest";

import {
  RuntimeMeasurementError,
  runtimeMeasurementDraft,
} from "./measurement";
import taskFixture from "../../../../packages/contracts/fixtures/runner/task-v2.json";

const execution = runnerExecutionV1Schema.parse({
  version: "1",
  lease: {
    version: "1",
    runnerId: "10000000-0000-4000-8000-000000000001",
    taskId: taskFixture.taskId,
    attemptId: "20000000-0000-4000-8000-000000000002",
    fence: 1,
    leasedUntil: "2026-07-31T18:00:00.000Z",
  },
  task: taskFixture,
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("runtime measurement draft", () => {
  it("validates canonical result bytes against the frozen metric", () => {
    expect(
      runtimeMeasurementDraft({
        chunks: [bytes('{"schema":"metric-value.v1","value":"1.25"}')],
        measurement: execution.task.measurement,
      }),
    ).toEqual({
      type: "measurement.recorded",
      payload: {
        metricDefinitionId: execution.task.measurement.metricDefinitionId,
        amount: "1.25",
        unit: execution.task.measurement.unit,
        sampleCount: 1,
      },
    });
  });

  it.each([
    '{"value":"1.25","schema":"metric-value.v1"}',
    '{"schema":"metric-value.v1","value":"1.25","unit":"score"}',
    '{"schema":"metric-value.v1","value":"01.25"}',
    '{"schema":"other","value":"1.25"}',
    '{"schema":"metric-value.v1","value":1.25}',
    "not-json",
  ])("rejects invalid result %s", (result) => {
    expect(() =>
      runtimeMeasurementDraft({
        chunks: [bytes(result)],
        measurement: execution.task.measurement,
      }),
    ).toThrow(RuntimeMeasurementError);
  });

  it("rejects invalid UTF-8 and the frozen byte limit", () => {
    expect(() =>
      runtimeMeasurementDraft({
        chunks: [Uint8Array.from([0x80])],
        measurement: execution.task.measurement,
      }),
    ).toThrow(/UTF-8/u);
    expect(() =>
      runtimeMeasurementDraft({
        chunks: [
          new Uint8Array(execution.task.measurement.result.maximumBytes + 1),
        ],
        measurement: execution.task.measurement,
      }),
    ).toThrow(/byte limit/u);
  });
});
