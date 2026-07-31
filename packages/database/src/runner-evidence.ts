import { runnerEventV2Schema, type RunnerEventV2 } from "@socrates/contracts";
import { redactEvidenceText } from "@socrates/evidence-policy";

const utf8Encoder = new TextEncoder();

export function redactRunnerEvent(event: RunnerEventV2): RunnerEventV2 {
  if (event.type !== "log.appended") return event;

  const redacted = redactEvidenceText(event.payload.text);

  return runnerEventV2Schema.parse({
    ...event,
    payload: {
      ...event.payload,
      text: redacted.text,
      utf8Bytes: utf8Encoder.encode(redacted.text).byteLength,
      redacted: event.payload.redacted || redacted.matched,
    },
  });
}
