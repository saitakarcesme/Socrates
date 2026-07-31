import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  maximumRunnerLeaseDurationMs,
  runnerBearerTokenSchema,
  runnerEventSubmitResponseV1Schema,
  runnerTaskDeliveryAcquireRequestV1Schema,
  runnerTaskDeliveryAcquireResponseV1Schema,
  runnerTaskDeliveryClaimRequestV1Schema,
  runnerTaskClaimRequestV1Schema,
  runnerTaskHeartbeatRequestV1Schema,
  runnerTaskHeartbeatResponseV1Schema,
} from "./runner-transport";

describe("runner transport contracts", () => {
  it("accepts only the fixed opaque runner credential format", () => {
    const valid = `srt1.${randomUUID()}.${"a".repeat(43)}`;

    expect(runnerBearerTokenSchema.parse(valid)).toBe(valid);
    for (const invalid of [
      valid.replace("srt1", "srt2"),
      `${valid}=`,
      valid.toUpperCase(),
      `Bearer ${valid}`,
    ]) {
      expect(runnerBearerTokenSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("bounds requested leases and rejects unknown request fields", () => {
    const request = {
      version: "1",
      attemptId: randomUUID(),
      leaseDurationMs: maximumRunnerLeaseDurationMs,
    } as const;

    expect(runnerTaskClaimRequestV1Schema.parse(request)).toEqual(request);
    expect(
      runnerTaskClaimRequestV1Schema.safeParse({
        ...request,
        runnerId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      runnerTaskHeartbeatRequestV1Schema.safeParse({
        version: "1",
        fence: 1,
        leaseDurationMs: maximumRunnerLeaseDurationMs + 1,
      }).success,
    ).toBe(false);
  });

  it("keeps heartbeat directives and event acknowledgements closed", () => {
    expect(
      runnerTaskHeartbeatResponseV1Schema.parse({
        version: "1",
        leaseExpiresAt: "2026-07-31T12:00:00.000Z",
        directive: "cancel",
      }).directive,
    ).toBe("cancel");
    expect(
      runnerTaskHeartbeatResponseV1Schema.safeParse({
        version: "1",
        leaseExpiresAt: "2026-07-31T12:00:00.000Z",
        directive: "pause",
      }).success,
    ).toBe(false);

    const acknowledgement = {
      version: "1",
      eventId: randomUUID(),
      attemptId: randomUUID(),
      acknowledgedSequence: 1,
      expectedSequence: 2,
      receivedAt: "2026-07-31T12:00:00.000Z",
    } as const;
    expect(
      runnerEventSubmitResponseV1Schema.parse({
        version: "1",
        replay: false,
        acknowledgement,
      }).acknowledgement,
    ).toEqual(acknowledgement);
  });

  it("keeps task acquisition principal-derived and delivery claims exact", () => {
    const deliveryId = randomUUID();
    const taskId = randomUUID();
    expect(
      runnerTaskDeliveryAcquireResponseV1Schema.parse({
        version: "1",
        delivery: { version: "1", deliveryId, taskId },
      }).delivery,
    ).toEqual({ version: "1", deliveryId, taskId });
    expect(
      runnerTaskDeliveryAcquireRequestV1Schema.safeParse({
        version: "1",
        runnerId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      runnerTaskDeliveryClaimRequestV1Schema.parse({
        version: "1",
        taskId,
        attemptId: randomUUID(),
        leaseDurationMs: maximumRunnerLeaseDurationMs,
      }).taskId,
    ).toBe(taskId);
  });
});
