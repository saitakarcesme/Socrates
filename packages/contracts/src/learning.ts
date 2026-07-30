import { z } from "zod";

import { entityIdSchema } from "./common";
import { pageInfoSchema } from "./pagination";

export const learningStatusSchema = z.enum([
  "active",
  "superseded",
  "retracted",
]);

export const learningResourceSchema = z
  .object({
    id: entityIdSchema,
    projectId: entityIdSchema,
    statement: z.string(),
    confidence: z.number().min(0).max(1),
    status: learningStatusSchema,
    supersededLearningId: entityIdSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type LearningResource = z.infer<typeof learningResourceSchema>;

export const learningListResponseSchema = z
  .object({
    data: z.array(learningResourceSchema),
    page: pageInfoSchema,
  })
  .strict();
export type LearningListResponse = z.infer<typeof learningListResponseSchema>;
