import { sValidator } from "@hono/standard-validator";
import {
  cursorQuerySchema,
  eventCursorQuerySchema,
  experimentIdParamSchema,
  projectIdParamSchema,
  runIdParamSchema,
} from "@socrates/contracts";
import type { ReadRepository } from "@socrates/database";
import { Hono } from "hono";

import { decodeCursor, encodeCursor } from "../../http/cursor";
import { apiError, validationHook } from "../../http/errors";
import type { RunEventNotifier } from "../../realtime/run-event-notifier";
import {
  mapExperiment,
  mapLearning,
  mapProjectDetail,
  mapProjectSummary,
  mapRun,
  mapRunEvent,
} from "./mappers";
import {
  acceptsEventStream,
  InvalidEventCursorError,
  resolveEventCursor,
  streamRunEvents,
} from "./run-event-stream";

export type ReadRoutesOptions = {
  reads: ReadRepository | null;
  runEventNotifier?: RunEventNotifier | null;
  workspaceId: string;
};

export function createReadRoutes(options: ReadRoutesOptions) {
  const app = new Hono();
  const reads = options.reads;

  if (!reads) {
    const unavailable = (context: Parameters<typeof apiError>[0]) =>
      apiError(
        context,
        503,
        "service_unavailable",
        "The persistence dependency is not configured.",
      );

    app.get("/projects", unavailable);
    app.get("/projects/:projectId", unavailable);
    app.get("/projects/:projectId/runs", unavailable);
    app.get("/runs/:runId", unavailable);
    app.get("/runs/:runId/experiments", unavailable);
    app.get("/experiments/:experimentId", unavailable);
    app.get("/learnings", unavailable);
    app.get("/projects/:projectId/learnings", unavailable);
    app.get("/runs/:runId/events", unavailable);

    return app;
  }

  app.get(
    "/projects",
    sValidator("query", cursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      const page = await reads.listProjects({
        workspaceId: options.workspaceId,
        cursor: decodeCursor(query.cursor),
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapProjectSummary),
        page: {
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        },
      });
    },
  );

  app.get(
    "/projects/:projectId",
    sValidator("param", projectIdParamSchema, validationHook),
    async (context) => {
      const project = await reads.getProject(
        options.workspaceId,
        context.req.valid("param").projectId,
      );

      if (!project) {
        return apiError(
          context,
          404,
          "not_found",
          "The requested project does not exist.",
        );
      }

      return context.json({ data: mapProjectDetail(project) });
    },
  );

  app.get(
    "/projects/:projectId/runs",
    sValidator("param", projectIdParamSchema, validationHook),
    sValidator("query", cursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      const page = await reads.listRuns({
        workspaceId: options.workspaceId,
        projectId: context.req.valid("param").projectId,
        cursor: decodeCursor(query.cursor),
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapRun),
        page: {
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        },
      });
    },
  );

  app.get(
    "/runs/:runId",
    sValidator("param", runIdParamSchema, validationHook),
    async (context) => {
      const run = await reads.getRun(
        options.workspaceId,
        context.req.valid("param").runId,
      );

      if (!run) {
        return apiError(
          context,
          404,
          "not_found",
          "The requested run does not exist.",
        );
      }

      return context.json({ data: mapRun(run) });
    },
  );

  app.get(
    "/runs/:runId/experiments",
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("query", cursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      const page = await reads.listExperiments({
        workspaceId: options.workspaceId,
        runId: context.req.valid("param").runId,
        cursor: decodeCursor(query.cursor),
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapExperiment),
        page: {
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        },
      });
    },
  );

  app.get(
    "/experiments/:experimentId",
    sValidator("param", experimentIdParamSchema, validationHook),
    async (context) => {
      const experiment = await reads.getExperiment(
        options.workspaceId,
        context.req.valid("param").experimentId,
      );

      if (!experiment) {
        return apiError(
          context,
          404,
          "not_found",
          "The requested experiment does not exist.",
        );
      }

      return context.json({ data: mapExperiment(experiment) });
    },
  );

  app.get(
    "/learnings",
    sValidator("query", cursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      const page = await reads.listWorkspaceLearnings({
        workspaceId: options.workspaceId,
        cursor: decodeCursor(query.cursor),
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapLearning),
        page: {
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        },
      });
    },
  );

  app.get(
    "/projects/:projectId/learnings",
    sValidator("param", projectIdParamSchema, validationHook),
    sValidator("query", cursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      const page = await reads.listLearnings({
        workspaceId: options.workspaceId,
        projectId: context.req.valid("param").projectId,
        cursor: decodeCursor(query.cursor),
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapLearning),
        page: {
          nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        },
      });
    },
  );

  app.get(
    "/runs/:runId/events",
    sValidator("param", runIdParamSchema, validationHook),
    sValidator("query", eventCursorQuerySchema, validationHook),
    async (context) => {
      const query = context.req.valid("query");
      if (acceptsEventStream(context.req.header("accept"))) {
        if (!options.runEventNotifier) {
          return apiError(
            context,
            503,
            "service_unavailable",
            "The realtime dependency is not configured.",
          );
        }

        const runId = context.req.valid("param").runId;
        const run = await reads.getRun(options.workspaceId, runId);
        if (!run) {
          return apiError(
            context,
            404,
            "not_found",
            "The requested run does not exist.",
          );
        }

        let after: number;
        try {
          after = resolveEventCursor(
            query.after,
            context.req.header("last-event-id"),
          );
        } catch (error) {
          if (error instanceof InvalidEventCursorError) {
            return apiError(context, 400, "validation_failed", error.message);
          }
          throw error;
        }

        return streamRunEvents({
          context,
          reads,
          notifier: options.runEventNotifier,
          workspaceId: options.workspaceId,
          runId,
          after,
        });
      }

      const page = await reads.listRunEvents({
        workspaceId: options.workspaceId,
        runId: context.req.valid("param").runId,
        after: query.after,
        limit: query.limit,
      });

      return context.json({
        data: page.items.map(mapRunEvent),
        page: {
          nextCursor: page.nextCursor,
        },
      });
    },
  );

  return app;
}
