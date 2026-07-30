import type { ReadRepository, RunEventRead } from "@socrates/database";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { RunEventNotifier } from "../../realtime/run-event-notifier";
import { mapRunEvent } from "./mappers";

const maximumCursor = Number.MAX_SAFE_INTEGER;

export class InvalidEventCursorError extends Error {
  constructor() {
    super("The event cursor must be a non-negative safe integer.");
    this.name = "InvalidEventCursorError";
  }
}

export function acceptsEventStream(accept: string | undefined): boolean {
  return (
    accept?.split(",").some((range) => {
      const [mediaType, ...parameters] = range
        .split(";")
        .map((value) => value.trim().toLowerCase());
      if (mediaType !== "text/event-stream") return false;

      const quality = parameters
        .find((parameter) => parameter.startsWith("q="))
        ?.slice(2);
      return quality === undefined || Number(quality) > 0;
    }) ?? false
  );
}

export function resolveEventCursor(
  after: number,
  lastEventId: string | undefined,
): number {
  if (lastEventId === undefined || lastEventId === "") return after;
  if (!/^(0|[1-9]\d*)$/.test(lastEventId)) {
    throw new InvalidEventCursorError();
  }

  const cursor = Number(lastEventId);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > maximumCursor) {
    throw new InvalidEventCursorError();
  }

  return cursor;
}

type RunEventStreamOptions = {
  context: Context;
  reads: ReadRepository;
  notifier: RunEventNotifier;
  workspaceId: string;
  runId: string;
  after: number;
  reconciliationMs?: number;
  heartbeatMs?: number;
  batchSize?: number;
};

function serializeEvent(event: RunEventRead): string {
  return JSON.stringify(mapRunEvent(event));
}

export function streamRunEvents(options: RunEventStreamOptions) {
  const reconciliationMs = options.reconciliationMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const batchSize = options.batchSize ?? 100;

  return streamSSE(options.context, async (stream) => {
    const abortController = new AbortController();
    let cursor = options.after;
    let lastWriteAt = Date.now();

    stream.onAbort(() => abortController.abort());
    await stream.write(": connected\n\n");

    while (!stream.aborted && !abortController.signal.aborted) {
      let hasMore = true;

      while (hasMore && !stream.aborted) {
        const page = await options.reads.listRunEvents({
          workspaceId: options.workspaceId,
          runId: options.runId,
          after: cursor,
          limit: batchSize,
        });

        for (const event of page.items) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: "run-event",
            data: serializeEvent(event),
            retry: 1_000,
          });
          cursor = event.sequence;
          lastWriteAt = Date.now();
        }

        hasMore = page.nextCursor !== null;
      }

      if (Date.now() - lastWriteAt >= heartbeatMs) {
        await stream.write(": heartbeat\n\n");
        lastWriteAt = Date.now();
      }

      await options.notifier.wait(
        options.runId,
        reconciliationMs,
        abortController.signal,
      );
    }
  });
}
