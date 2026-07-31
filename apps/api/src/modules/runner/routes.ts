import { sValidator } from "@hono/standard-validator";
import type { ArtifactStore } from "@socrates/artifact-store";
import {
  experimentTaskV2Schema,
  runnerEventSubmitRequestV1Schema,
  runnerEventSubmitResponseV1Schema,
  runnerExecutionV1Schema,
  runnerSourceSnapshotResolveParamsV1Schema,
  runnerSourceSnapshotResolveRequestV1Schema,
  runnerTaskDeliveryAcquireRequestV1Schema,
  runnerTaskDeliveryAcquireResponseV1Schema,
  runnerTaskDeliveryClaimParamsV1Schema,
  runnerTaskDeliveryClaimRequestV1Schema,
  runnerTaskClaimParamsV1Schema,
  runnerTaskClaimRequestV1Schema,
  runnerTaskClaimResponseV1Schema,
  runnerTaskHeartbeatParamsV1Schema,
  runnerTaskHeartbeatRequestV1Schema,
  runnerTaskHeartbeatResponseV1Schema,
} from "@socrates/contracts";
import type { RunnerAuthenticator } from "@socrates/runner-auth";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { RunnerGatewayService } from "../../application/runner-gateway-service";
import { apiError, validationHook } from "../../http/errors";
import { runnerAuthentication, type RunnerHttpEnvironment } from "./auth";

const maximumRunnerRequestBytes = 128 * 1_024;

type RunnerGateway = Pick<
  RunnerGatewayService,
  | "acquireTaskDelivery"
  | "authorizeSourceSnapshot"
  | "claimTaskDelivery"
  | "claimTask"
  | "heartbeat"
  | "ingestEvent"
>;

export type RunnerRouteOptions = {
  authenticator: RunnerAuthenticator | null;
  artifactStore?: ArtifactStore | null;
  gateway: RunnerGateway | null;
};

function artifactStream(
  content: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = content[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export function createRunnerRoutes(options: RunnerRouteOptions) {
  const app = new Hono<RunnerHttpEnvironment>();

  if (!options.authenticator || !options.gateway) {
    app.all("*", (context) =>
      apiError(
        context,
        503,
        "service_unavailable",
        "The runner gateway is not configured.",
      ),
    );
    return app;
  }

  const gateway = options.gateway;
  app.use("*", runnerAuthentication(options.authenticator));
  app.use(
    "*",
    bodyLimit({
      maxSize: maximumRunnerRequestBytes,
      onError: (context) =>
        apiError(
          context,
          413,
          "validation_failed",
          "The runner request body exceeds its byte limit.",
        ),
    }),
  );

  app.post(
    "/task-deliveries/acquire",
    sValidator(
      "json",
      runnerTaskDeliveryAcquireRequestV1Schema,
      validationHook,
    ),
    async (context) => {
      const principal = context.get("runnerPrincipal");
      const delivery = await gateway.acquireTaskDelivery({
        runnerId: principal.runnerId,
      });
      if (!delivery) return context.body(null, 204);
      return context.json(
        runnerTaskDeliveryAcquireResponseV1Schema.parse({
          version: "1",
          delivery: { version: "1", ...delivery },
        }),
      );
    },
  );

  app.post(
    "/task-deliveries/:deliveryId/claims",
    sValidator("param", runnerTaskDeliveryClaimParamsV1Schema, validationHook),
    sValidator("json", runnerTaskDeliveryClaimRequestV1Schema, validationHook),
    async (context) => {
      const principal = context.get("runnerPrincipal");
      const params = context.req.valid("param");
      const request = context.req.valid("json");
      const claim = await gateway.claimTaskDelivery({
        runnerId: principal.runnerId,
        deliveryId: params.deliveryId,
        taskId: request.taskId,
        attemptId: request.attemptId,
        leaseDurationMs: request.leaseDurationMs,
      });
      const execution = runnerExecutionV1Schema.parse({
        version: "1",
        lease: {
          version: "1",
          runnerId: claim.runnerId,
          taskId: claim.taskId,
          attemptId: claim.attemptId,
          fence: claim.fence,
          leasedUntil: claim.leaseExpiresAt.toISOString(),
        },
        task: experimentTaskV2Schema.parse(claim.payload),
      });
      return context.json(
        runnerTaskClaimResponseV1Schema.parse({ version: "1", execution }),
      );
    },
  );

  app.post(
    "/tasks/:taskId/claims",
    sValidator("param", runnerTaskClaimParamsV1Schema, validationHook),
    sValidator("json", runnerTaskClaimRequestV1Schema, validationHook),
    async (context) => {
      const principal = context.get("runnerPrincipal");
      const params = context.req.valid("param");
      const request = context.req.valid("json");
      const claim = await gateway.claimTask({
        runnerId: principal.runnerId,
        taskId: params.taskId,
        attemptId: request.attemptId,
        leaseDurationMs: request.leaseDurationMs,
      });
      const execution = runnerExecutionV1Schema.parse({
        version: "1",
        lease: {
          version: "1",
          runnerId: claim.runnerId,
          taskId: claim.taskId,
          attemptId: claim.attemptId,
          fence: claim.fence,
          leasedUntil: claim.leaseExpiresAt.toISOString(),
        },
        task: experimentTaskV2Schema.parse(claim.payload),
      });

      return context.json(
        runnerTaskClaimResponseV1Schema.parse({ version: "1", execution }),
      );
    },
  );

  app.post(
    "/tasks/:taskId/attempts/:attemptId/heartbeat",
    sValidator("param", runnerTaskHeartbeatParamsV1Schema, validationHook),
    sValidator("json", runnerTaskHeartbeatRequestV1Schema, validationHook),
    async (context) => {
      const principal = context.get("runnerPrincipal");
      const params = context.req.valid("param");
      const request = context.req.valid("json");
      const heartbeat = await gateway.heartbeat({
        runnerId: principal.runnerId,
        taskId: params.taskId,
        attemptId: params.attemptId,
        fence: request.fence,
        leaseDurationMs: request.leaseDurationMs,
      });

      return context.json(
        runnerTaskHeartbeatResponseV1Schema.parse(
          heartbeat.directive === "continue"
            ? {
                version: "1",
                leaseExpiresAt: heartbeat.leaseExpiresAt.toISOString(),
                directive: "continue",
              }
            : {
                version: "1",
                leaseExpiresAt: heartbeat.leaseExpiresAt.toISOString(),
                directive: "cancel",
                cancellation: {
                  ...heartbeat.cancellation,
                  requestedAt: heartbeat.cancellation.requestedAt.toISOString(),
                },
              },
        ),
      );
    },
  );

  app.post(
    "/tasks/:taskId/attempts/:attemptId/source-snapshots/resolve",
    sValidator(
      "param",
      runnerSourceSnapshotResolveParamsV1Schema,
      validationHook,
    ),
    sValidator(
      "json",
      runnerSourceSnapshotResolveRequestV1Schema,
      validationHook,
    ),
    async (context) => {
      if (!options.artifactStore) {
        return apiError(
          context,
          503,
          "service_unavailable",
          "The source artifact store is not configured.",
        );
      }
      const principal = context.get("runnerPrincipal");
      const params = context.req.valid("param");
      const request = context.req.valid("json");
      const source = await gateway.authorizeSourceSnapshot({
        runnerId: principal.runnerId,
        taskId: params.taskId,
        attemptId: params.attemptId,
        fence: request.fence,
        snapshotId: request.snapshotId,
        digest: request.digest,
      });
      let content: AsyncIterable<Uint8Array> | undefined;
      try {
        const artifact = await options.artifactStore.verify({
          expectedDigest: source.digest,
          expectedSizeBytes: source.sizeBytes,
        });
        if (artifact) {
          content = options.artifactStore.read({
            artifact,
            maxSizeBytes: source.sizeBytes,
          });
        }
      } catch {
        content = undefined;
      }
      if (!content) {
        return apiError(
          context,
          503,
          "service_unavailable",
          "The authorized source object is unavailable.",
        );
      }

      return context.body(artifactStream(content), 200, {
        "cache-control": "no-store",
        "content-length": String(source.sizeBytes),
        "content-type": source.mediaType,
        "x-content-type-options": "nosniff",
      });
    },
  );

  app.post(
    "/events",
    sValidator("json", runnerEventSubmitRequestV1Schema, validationHook),
    async (context) => {
      const principal = context.get("runnerPrincipal");
      const event = context.req.valid("json").event;
      if (event.runnerId !== principal.runnerId) {
        return apiError(
          context,
          403,
          "forbidden",
          "The runner credential is not authorized for this event.",
        );
      }

      const result = await gateway.ingestEvent({ event });
      return context.json(
        runnerEventSubmitResponseV1Schema.parse({
          version: "1",
          replay: result.replay,
          acknowledgement: {
            version: "1",
            eventId: result.acknowledgement.eventId,
            attemptId: result.acknowledgement.attemptId,
            acknowledgedSequence: result.acknowledgement.acknowledgedSequence,
            expectedSequence: result.acknowledgement.expectedSequence,
            receivedAt: result.acknowledgement.receivedAt.toISOString(),
          },
        }),
      );
    },
  );

  return app;
}
