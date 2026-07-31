import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  executableExperimentTaskSchema,
  experimentTaskV1Schema,
  experimentTaskV2Schema,
  runnerEventV1Schema,
  runnerEventV2Schema,
  runnerExecutionV1Schema,
  runnerRegistrationV1Schema,
} from "./index";

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/runner/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

describe("runner protocol compatibility", () => {
  it("keeps historical V1 fixtures parseable but non-executable", () => {
    const task = readFixture("task-v1.json");
    const event = readFixture("event-v1.json");

    expect(experimentTaskV1Schema.safeParse(task).success).toBe(true);
    expect(runnerEventV1Schema.safeParse(event).success).toBe(true);
    expect(executableExperimentTaskSchema.safeParse(task).success).toBe(false);
  });

  it("accepts committed V2 task and event fixtures", () => {
    expect(
      experimentTaskV2Schema.safeParse(readFixture("task-v2.json")).success,
    ).toBe(true);
    expect(
      runnerEventV2Schema.safeParse(readFixture("event-v2.json")).success,
    ).toBe(true);
  });

  it("rejects mutable image tags and workspace traversal", () => {
    const fixture = experimentTaskV2Schema.parse(readFixture("task-v2.json"));
    const task = {
      ...fixture,
      environment: { ...fixture.environment, imageDigest: "node:latest" },
      action: {
        ...fixture.action,
        steps: fixture.action.steps.map((step, index) =>
          index === 0
            ? { ...step, workingDirectory: "/workspace/../host" }
            : step,
        ),
      },
    };

    expect(experimentTaskV2Schema.safeParse(task).success).toBe(false);
  });

  it.each(["/usr/bin/../bin/node", "/usr//bin/node", "/usr/./bin/node"])(
    "rejects non-normalized executable path %s",
    (executable) => {
      const fixture = experimentTaskV2Schema.parse(readFixture("task-v2.json"));
      const task = {
        ...fixture,
        action: {
          ...fixture.action,
          steps: [{ ...fixture.action.steps[0], executable }],
        },
      };

      expect(experimentTaskV2Schema.safeParse(task).success).toBe(false);
    },
  );

  it("requires the network policy, budget, and capability to agree", () => {
    const fixture = experimentTaskV2Schema.parse(readFixture("task-v2.json"));
    const task = {
      ...fixture,
      budget: { ...fixture.budget, egressBytes: 1 },
      environment: {
        ...fixture.environment,
        requiredCapabilities: fixture.environment.requiredCapabilities.map(
          (capability) =>
            capability.kind === "network.egress"
              ? { ...capability, mode: "allowlist" as const }
              : capability,
        ),
      },
    };

    expect(experimentTaskV2Schema.safeParse(task).success).toBe(false);
  });

  it("rejects free-form and duplicate capabilities", () => {
    const fixture = experimentTaskV2Schema.parse(readFixture("task-v2.json"));
    const task = {
      ...fixture,
      environment: {
        ...fixture.environment,
        requiredCapabilities: [
          ...fixture.environment.requiredCapabilities,
          { kind: "action.command", shell: false },
          { kind: "host.shell" },
        ],
      },
    };

    expect(experimentTaskV2Schema.safeParse(task).success).toBe(false);
  });
});

describe("runner registration", () => {
  const registration = {
    version: "1",
    runnerId: "019c1170-8b7a-7a60-b7f8-f35c85d73747",
    kind: "local",
    softwareVersion: "0.1.0",
    taskProtocolVersions: ["2"],
    eventProtocolVersions: ["2"],
    sandboxBackend: "oci",
    capabilities: [
      {
        kind: "sandbox.oci",
        platform: "linux",
        architecture: "amd64",
      },
      { kind: "action.command", shell: false },
      { kind: "network.egress", mode: "disabled" },
    ],
    capacity: { maximumConcurrentTasks: 1 },
  };

  it("accepts a closed, V2-compatible capability declaration", () => {
    expect(runnerRegistrationV1Schema.safeParse(registration).success).toBe(
      true,
    );
  });

  it("rejects runners without command isolation capabilities", () => {
    expect(
      runnerRegistrationV1Schema.safeParse({
        ...registration,
        capabilities: [registration.capabilities[2]],
      }).success,
    ).toBe(false);
  });
});

describe("runner attempt lease", () => {
  it("binds execution to the claimed task identity", () => {
    const task = experimentTaskV2Schema.parse(readFixture("task-v2.json"));
    const execution = {
      version: "1",
      lease: {
        version: "1",
        runnerId: "019c1170-8b7a-7a60-b7f8-f35c85d73747",
        taskId: task.taskId,
        attemptId: "019c1170-8b7a-7a60-b7f8-f35c85d73748",
        fence: 1,
        leasedUntil: "2026-07-31T00:05:00.000Z",
      },
      task,
    };

    expect(runnerExecutionV1Schema.safeParse(execution).success).toBe(true);
    expect(
      runnerExecutionV1Schema.safeParse({
        ...execution,
        lease: {
          ...execution.lease,
          taskId: "019c1170-8b7a-7a60-b7f8-f35c85d73749",
        },
      }).success,
    ).toBe(false);
  });
});

describe("runner terminal events", () => {
  it("requires a dimension only for budget failures", () => {
    const fixture = runnerEventV2Schema.parse(readFixture("event-v2.json"));
    const envelope = {
      version: fixture.version,
      eventId: fixture.eventId,
      runnerId: fixture.runnerId,
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      fence: fixture.fence,
      sequence: fixture.sequence,
      occurredAt: fixture.occurredAt,
    };

    expect(
      runnerEventV2Schema.safeParse({
        ...envelope,
        type: "task.failed",
        payload: {
          classification: "budget",
          message: "Memory limit exceeded.",
        },
      }).success,
    ).toBe(false);
    expect(
      runnerEventV2Schema.safeParse({
        ...envelope,
        type: "task.failed",
        payload: {
          classification: "budget",
          budgetDimension: "memory",
          message: "Memory limit exceeded.",
        },
      }).success,
    ).toBe(true);
    expect(
      runnerEventV2Schema.safeParse({
        ...envelope,
        type: "task.failed",
        payload: {
          classification: "policy",
          budgetDimension: "memory",
          message: "Policy rejected the action.",
        },
      }).success,
    ).toBe(false);
  });

  it("verifies the declared UTF-8 byte count for log chunks", () => {
    const fixture = runnerEventV2Schema.parse(readFixture("event-v2.json"));
    const event = {
      version: fixture.version,
      eventId: fixture.eventId,
      runnerId: fixture.runnerId,
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      fence: fixture.fence,
      sequence: fixture.sequence,
      occurredAt: fixture.occurredAt,
      type: "log.appended",
      payload: {
        stream: "stdout",
        text: "ölçüm",
        utf8Bytes: 5,
        redacted: true,
      },
    };

    expect(runnerEventV2Schema.safeParse(event).success).toBe(false);
    expect(
      runnerEventV2Schema.safeParse({
        ...event,
        payload: { ...event.payload, utf8Bytes: 8 },
      }).success,
    ).toBe(true);
  });

  it("rejects parameterized, mixed-case, and traversal-shaped media types", () => {
    const fixture = runnerEventV2Schema.parse(readFixture("event-v2.json"));
    const event = {
      version: fixture.version,
      eventId: fixture.eventId,
      runnerId: fixture.runnerId,
      taskId: fixture.taskId,
      attemptId: fixture.attemptId,
      fence: fixture.fence,
      sequence: fixture.sequence,
      occurredAt: fixture.occurredAt,
      type: "artifact.produced",
      payload: {
        artifactId: fixture.attemptId,
        digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sizeBytes: 12,
        role: "diagnostic",
      },
    };

    expect(
      runnerEventV2Schema.safeParse({
        ...event,
        payload: { ...event.payload, mediaType: "application/json" },
      }).success,
    ).toBe(true);
    for (const mediaType of [
      "application/json; charset=utf-8",
      "Application/JSON",
      "../../text/plain",
    ]) {
      expect(
        runnerEventV2Schema.safeParse({
          ...event,
          payload: { ...event.payload, mediaType },
        }).success,
      ).toBe(false);
    }
  });
});
