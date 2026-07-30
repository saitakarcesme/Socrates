import { z } from "zod";

import {
  entityIdSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "./common";

export const cursorQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const eventCursorQuerySchema = z
  .object({
    after: z.coerce.number().pipe(nonNegativeSafeIntegerSchema).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
export type EventCursorQuery = z.infer<typeof eventCursorQuerySchema>;

export const projectIdParamSchema = z
  .object({ projectId: entityIdSchema })
  .strict();
export const runIdParamSchema = z.object({ runId: entityIdSchema }).strict();
export const experimentIdParamSchema = z
  .object({ experimentId: entityIdSchema })
  .strict();

export const pageInfoSchema = z
  .object({
    nextCursor: z.string().nullable(),
  })
  .strict();

export const eventPageInfoSchema = z
  .object({
    nextCursor: positiveSafeIntegerSchema.nullable(),
  })
  .strict();
