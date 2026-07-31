import type {
  RunnerAuthenticator,
  RunnerPrincipal,
} from "@socrates/runner-auth";
import { createMiddleware } from "hono/factory";

import { apiError } from "../../http/errors";

export type RunnerHttpEnvironment = {
  Variables: { runnerPrincipal: RunnerPrincipal };
};

const bearerPattern = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

export function runnerAuthentication(authenticator: RunnerAuthenticator) {
  return createMiddleware<RunnerHttpEnvironment>(async (context, next) => {
    const authorization = context.req.header("authorization") ?? "";
    const credential = bearerPattern.exec(authorization)?.[1];
    const principal = credential
      ? await authenticator.authenticate(credential)
      : null;
    if (!principal) {
      context.header("WWW-Authenticate", 'Bearer realm="socrates-runner"');
      return apiError(
        context,
        401,
        "unauthorized",
        "Valid runner authentication is required.",
      );
    }

    context.set("runnerPrincipal", principal);
    await next();
  });
}
