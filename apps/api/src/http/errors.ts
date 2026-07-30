import type { ApiErrorCode } from "@socrates/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function apiError(
  context: Context,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return context.json(
    {
      error: {
        code,
        message,
        requestId: context.get("requestId"),
        ...(details ? { details } : {}),
      },
    },
    status,
  );
}

export function validationHook(
  result: {
    success: boolean;
    error?: readonly unknown[];
  },
  context: Context,
) {
  if (!result.success) {
    return apiError(
      context,
      400,
      "validation_failed",
      "The request parameters are invalid.",
      { issues: result.error ?? [] },
    );
  }
}
