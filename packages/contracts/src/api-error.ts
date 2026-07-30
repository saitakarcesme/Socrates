import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
  "validation_failed",
  "not_found",
  "invalid_transition",
  "version_conflict",
  "idempotency_conflict",
  "budget_exhausted",
  "protocol_mismatch",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string(),
        requestId: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
