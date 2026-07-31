import { z } from "zod";

import { entityIdSchema } from "./common";

export const runnerTaskDeliveryV1Schema = z
  .object({
    version: z.literal("1"),
    deliveryId: entityIdSchema,
    taskId: entityIdSchema,
  })
  .strict();
export type RunnerTaskDeliveryV1 = z.infer<typeof runnerTaskDeliveryV1Schema>;
