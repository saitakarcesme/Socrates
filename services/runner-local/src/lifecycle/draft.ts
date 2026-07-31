import { runnerEventV2Schema, type RunnerEventV2 } from "@socrates/contracts";

export type RunnerEventDraft = RunnerEventV2 extends infer Event
  ? Event extends RunnerEventV2
    ? Readonly<Pick<Event, "type" | "payload">>
    : never
  : never;

const validationEnvelope = Object.freeze({
  version: "2" as const,
  eventId: "00000000-0000-4000-8000-000000000001",
  runnerId: "00000000-0000-4000-8000-000000000002",
  taskId: "00000000-0000-4000-8000-000000000003",
  attemptId: "00000000-0000-4000-8000-000000000004",
  fence: 1,
  sequence: 1,
  occurredAt: "2000-01-01T00:00:00.000Z",
});

export function runnerEventDraft(input: RunnerEventDraft): RunnerEventDraft {
  const parsed = runnerEventV2Schema.parse({
    ...validationEnvelope,
    ...input,
  });
  return Object.freeze({
    type: parsed.type,
    payload: Object.freeze(parsed.payload),
  }) as RunnerEventDraft;
}
