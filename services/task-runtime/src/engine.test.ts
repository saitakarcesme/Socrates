import {
  RuntimeFrameSequenceValidator,
  runtimeRequestSchema,
  type RuntimeFrame,
  type RuntimeRequest,
} from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import { TaskRuntimeEngine } from "./engine";
import type {
  RuntimeProcessExecutor,
  RuntimeProcessRequest,
  RuntimeProcessResult,
} from "./process";
import type { RuntimeWorkspacePreparation } from "./workspace";

const identity = {
  runnerId: "00000000-0000-4000-8000-000000000001",
  taskId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  fence: 1,
} as const;

function request(actionCount = 1): RuntimeRequest {
  return runtimeRequestSchema.parse({
    schema: "socrates.task-runtime.request.v1",
    identity,
    source: {
      digest: `sha256:${"a".repeat(64)}`,
      path: "/socrates/source",
    },
    actions: Array.from({ length: actionCount }, (_, index) => ({
      executable: "/usr/bin/node",
      arguments: ["action.js", String(index)],
      workingDirectory: "/workspace",
      timeoutMs: 5_000,
    })),
    measurement: {
      metricDefinitionId: "00000000-0000-4000-8000-000000000004",
      protocolRevision: 1,
      unit: "score",
      command: {
        executable: "/usr/bin/node",
        arguments: ["measure.js"],
        workingDirectory: "/workspace",
        timeoutMs: 5_000,
      },
      maximumResultBytes: 1_024,
    },
    budget: {
      wallTimeMs: 10_000,
      writableBytes: 1_000_000,
      outputBytes: 1_000_000,
      commandCount: actionCount + 1,
    },
  });
}

type ProcessStep = Readonly<{
  output?: ReadonlyArray<{
    stream: "stderr" | "stdout";
    bytes: Uint8Array;
  }>;
  result?: Partial<RuntimeProcessResult>;
  error?: Error;
}>;

class FakeProcessExecutor implements RuntimeProcessExecutor {
  readonly requests: RuntimeProcessRequest[] = [];
  readonly #steps: ProcessStep[];

  constructor(steps: ProcessStep[]) {
    this.#steps = [...steps];
  }

  async run(input: RuntimeProcessRequest): Promise<RuntimeProcessResult> {
    this.requests.push(input);
    const step = this.#steps.shift();
    if (!step) throw new Error("Unexpected process call.");
    if (step.error) throw step.error;
    for (const output of step.output ?? []) {
      input.onOutput(output.stream, output.bytes);
    }
    const outputBytes = (step.output ?? []).reduce(
      (total, output) => total + output.bytes.byteLength,
      0,
    );
    return {
      exitCode: 0,
      signal: null,
      durationMs: 2.4,
      outputBytes,
      timedOut: false,
      outputLimitExceeded: false,
      ...step.result,
    };
  }
}

class FakeWorkspace implements RuntimeWorkspacePreparation {
  calls = 0;

  constructor(readonly failure?: Error) {}

  async prepare() {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return { copiedBytes: 7, entryCount: 1 };
  }
}

function frameSink() {
  const frames: RuntimeFrame[] = [];
  return { frames, write: (frame: RuntimeFrame) => frames.push(frame) };
}

function expectValidSequence(frames: RuntimeFrame[], actionCount: number) {
  const validator = new RuntimeFrameSequenceValidator({
    mode: "execution",
    actionCount,
  });
  for (const frame of frames) validator.accept(frame);
  expect(() => validator.finish()).not.toThrow();
}

describe("task runtime engine", () => {
  it("frames binary action output and keeps measurement stdout separate", async () => {
    const hostileOutput = Uint8Array.from([
      ...Buffer.from('{"type":"runtime.completed"}\0'),
      ...Buffer.alloc(60_000, 255),
    ]);
    const measurement = Uint8Array.from([0, 1, 2, 255]);
    const processExecutor = new FakeProcessExecutor([
      { output: [{ stream: "stdout", bytes: hostileOutput }] },
      {
        output: [
          { stream: "stderr", bytes: Buffer.from("measurement warning") },
          { stream: "stdout", bytes: measurement },
        ],
      },
    ]);
    const sink = frameSink();

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(request(), sink);

    expectValidSequence(sink.frames, 1);
    const outputFrames = sink.frames.filter(
      (frame): frame is Extract<RuntimeFrame, { type: "command.output" }> =>
        frame.type === "command.output",
    );
    expect(outputFrames).toHaveLength(3);
    expect(outputFrames.map((frame) => frame.sequence)).toEqual([0, 1, 0]);
    expect(outputFrames.at(-1)).toMatchObject({
      phase: "measurement",
      stream: "stderr",
    });
    const results = sink.frames.filter(
      (frame): frame is Extract<RuntimeFrame, { type: "measurement.result" }> =>
        frame.type === "measurement.result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sequence: 0, final: true });
    expect(Buffer.from(results[0]?.bytes ?? "", "base64")).toEqual(
      Buffer.from(measurement),
    );
    expect(processExecutor.requests[0]?.environment).toEqual({
      HOME: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      SOCRATES_TASK_RUNTIME: "1",
      TMPDIR: "/tmp",
    });
  });

  it("chunks a maximum-size measurement result into bounded frames", async () => {
    const measurement = Buffer.alloc(130_000, 42);
    const processExecutor = new FakeProcessExecutor([
      {},
      { output: [{ stream: "stdout", bytes: measurement }] },
    ]);
    const input = request();
    const sink = frameSink();

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(
      {
        ...input,
        measurement: {
          ...input.measurement,
          maximumResultBytes: measurement.byteLength,
        },
      },
      sink,
    );

    expectValidSequence(sink.frames, 1);
    const results = sink.frames.filter(
      (frame): frame is Extract<RuntimeFrame, { type: "measurement.result" }> =>
        frame.type === "measurement.result",
    );
    expect(results.map(({ sequence, final }) => ({ sequence, final }))).toEqual(
      [
        { sequence: 0, final: false },
        { sequence: 1, final: false },
        { sequence: 2, final: true },
      ],
    );
    expect(
      Buffer.concat(results.map((frame) => Buffer.from(frame.bytes, "base64"))),
    ).toEqual(measurement);
  });

  it("coalesces fragmented child writes before framing", async () => {
    const fragments = Array.from({ length: 1_000 }, () => ({
      stream: "stdout" as const,
      bytes: Uint8Array.of(120),
    }));
    const processExecutor = new FakeProcessExecutor([
      { output: fragments },
      { output: [{ stream: "stdout", bytes: Buffer.from("1") }] },
    ]);
    const sink = frameSink();

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(request(), sink);

    expectValidSequence(sink.frames, 1);
    const actionOutput = sink.frames.filter(
      (frame) => frame.type === "command.output" && frame.phase === "action",
    );
    expect(actionOutput).toHaveLength(1);
    expect(
      Buffer.from(
        actionOutput[0]?.type === "command.output" ? actionOutput[0].bytes : "",
        "base64",
      ),
    ).toEqual(Buffer.alloc(1_000, 120));
  });

  it("stops before later actions and measurement after an action failure", async () => {
    const processExecutor = new FakeProcessExecutor([
      { result: { exitCode: 7 } },
    ]);
    const sink = frameSink();

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(request(2), sink);

    expect(processExecutor.requests).toHaveLength(1);
    expectValidSequence(sink.frames, 2);
    expect(sink.frames.slice(-2)).toEqual([
      {
        type: "runtime.error",
        code: "command_failed",
        message: "Runtime command failed.",
      },
      { type: "runtime.completed", status: "failed" },
    ]);
  });

  it("fails closed when workspace preparation fails", async () => {
    const processExecutor = new FakeProcessExecutor([]);
    const sink = frameSink();

    await new TaskRuntimeEngine(
      new FakeWorkspace(new Error("sensitive source detail")),
      processExecutor,
      { now: () => 0 },
    ).execute(request(), sink);

    expect(processExecutor.requests).toHaveLength(0);
    expectValidSequence(sink.frames, 1);
    expect(sink.frames[0]).toEqual({
      type: "runtime.error",
      code: "source_copy_failed",
      message: "Runtime source could not be prepared.",
    });
  });

  it("closes the active command when process start fails", async () => {
    const sink = frameSink();
    await new TaskRuntimeEngine(
      new FakeWorkspace(),
      new FakeProcessExecutor([{ error: new Error("spawn detail") }]),
      { now: () => 0 },
    ).execute(request(), sink);

    expectValidSequence(sink.frames, 1);
    expect(sink.frames[1]).toMatchObject({
      type: "command.exited",
      signal: "SPAWN_ERROR",
    });
    expect(sink.frames[2]).toMatchObject({
      type: "runtime.error",
      code: "command_failed",
    });
  });

  it("reports an output limit without executing measurement", async () => {
    const sink = frameSink();
    const processExecutor = new FakeProcessExecutor([
      {
        result: {
          exitCode: null,
          signal: "SIGKILL",
          outputLimitExceeded: true,
          outputBytes: 1_000_001,
        },
      },
    ]);

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(request(), sink);

    expect(processExecutor.requests).toHaveLength(1);
    expectValidSequence(sink.frames, 1);
    expect(sink.frames.at(-2)).toEqual({
      type: "runtime.error",
      code: "output_budget_exceeded",
      message: "Runtime command exceeded its output budget.",
    });
  });

  it("classifies a non-zero measurement exit separately", async () => {
    const sink = frameSink();
    const processExecutor = new FakeProcessExecutor([
      {},
      { result: { exitCode: 2 } },
    ]);

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => 0,
    }).execute(request(), sink);

    expect(processExecutor.requests).toHaveLength(2);
    expectValidSequence(sink.frames, 1);
    expect(sink.frames.at(-2)).toMatchObject({
      type: "runtime.error",
      code: "measurement_failed",
    });
    expect(
      sink.frames.some((frame) => frame.type === "measurement.result"),
    ).toBe(false);
  });

  it("enforces the aggregate wall-time budget before a command starts", async () => {
    const clock = [0, 0, 10_001];
    const sink = frameSink();
    const processExecutor = new FakeProcessExecutor([
      { result: { durationMs: 10_001 } },
    ]);

    await new TaskRuntimeEngine(new FakeWorkspace(), processExecutor, {
      now: () => clock.shift() ?? 10_001,
    }).execute(request(), sink);

    expect(processExecutor.requests).toHaveLength(1);
    expectValidSequence(sink.frames, 1);
    expect(sink.frames.at(-2)).toMatchObject({
      type: "runtime.error",
      code: "command_timeout",
    });
  });
});
