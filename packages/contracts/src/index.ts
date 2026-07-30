import { z } from "zod";

export const metricDirectionSchema = z.enum(["maximize", "minimize"]);
export type MetricDirection = z.infer<typeof metricDirectionSchema>;

export const experimentDecisionSchema = z.enum([
  "kept",
  "discarded",
  "inconclusive",
]);
export type ExperimentDecision = z.infer<typeof experimentDecisionSchema>;

export const experimentTaskV1Schema = z.object({
  version: z.literal("1"),
  runId: z.uuid(),
  experimentId: z.uuid(),
  hypothesis: z.string().min(1),
  actionPlan: z.object({
    summary: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
  }),
  metric: z.object({
    definitionId: z.uuid(),
    direction: metricDirectionSchema,
    minimumImprovement: z.number().nonnegative(),
  }),
  budget: z.object({
    maximumDurationMs: z.number().int().positive(),
    maximumCostMinor: z.number().int().nonnegative(),
  }),
});
export type ExperimentTaskV1 = z.infer<typeof experimentTaskV1Schema>;

const runnerEventEnvelopeSchema = z.object({
  version: z.literal("1"),
  eventId: z.uuid(),
  taskId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
});

export const runnerEventV1Schema = z.discriminatedUnion("type", [
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.accepted"),
    payload: z.object({ runnerId: z.uuid() }),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("log.appended"),
    payload: z.object({
      stream: z.enum(["stdout", "stderr", "system"]),
      text: z.string(),
    }),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("measurement.recorded"),
    payload: z.object({
      metricDefinitionId: z.uuid(),
      value: z.number(),
      unit: z.string(),
    }),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.succeeded"),
    payload: z.object({ exitCode: z.literal(0) }),
  }),
  runnerEventEnvelopeSchema.extend({
    type: z.literal("task.failed"),
    payload: z.object({
      classification: z.enum([
        "infrastructure",
        "invalid_action",
        "evaluation",
        "budget",
        "policy",
      ]),
      message: z.string(),
    }),
  }),
]);
export type RunnerEventV1 = z.infer<typeof runnerEventV1Schema>;
