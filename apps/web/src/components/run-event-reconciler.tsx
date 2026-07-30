"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { runEventStreamUrl } from "@/lib/api/browser";
import { classifyEventSequence } from "@/lib/api/event-cursor";

type ConnectionState = "connecting" | "live" | "recovering";

export function RunEventReconciler({
  initialSequence,
  runId,
}: {
  initialSequence: number;
  runId: string;
}) {
  const router = useRouter();
  const cursor = useRef(initialSequence);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    cursor.current = Math.max(cursor.current, initialSequence);
    let disposed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleRefresh() {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        router.refresh();
      }, 100);
    }

    function connect() {
      if (disposed) return;
      source = new EventSource(runEventStreamUrl(runId, cursor.current));
      source.onopen = () => setConnection("live");
      source.onerror = () => setConnection("recovering");
      source.addEventListener("run-event", (rawEvent) => {
        const event = rawEvent as MessageEvent;
        const sequence = Number(event.lastEventId);
        if (!Number.isSafeInteger(sequence) || sequence < 1) return;

        const advance = classifyEventSequence(cursor.current, sequence);
        if (advance === "duplicate") return;
        if (advance === "gap") {
          setConnection("recovering");
          source?.close();
          reconnectTimer = setTimeout(connect, 250);
          return;
        }

        cursor.current = sequence;
        scheduleRefresh();
      });
    }

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [initialSequence, router, runId]);

  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]"
      title="Durable run-event connection"
    >
      <span
        className={`size-1 rounded-full ${
          connection === "live" ? "bg-emerald-400" : "bg-amber-400"
        }`}
      />
      {connection}
    </span>
  );
}
