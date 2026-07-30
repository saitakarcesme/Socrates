import { Check, Circle, X } from "lucide-react";
import Link from "next/link";

import type { ExperimentDetailResource } from "@socrates/contracts";
import { Panel, StatusBadge, cn } from "@socrates/design-system";

import { formatDuration, formatMetric } from "@/lib/metric-presentation";

function DecisionIcon({
  status,
}: {
  status: ExperimentDetailResource["status"];
}) {
  const kept = status === "kept";
  const rejected = status === "discarded" || status === "failed";
  const active = !kept && !rejected;

  return (
    <span
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border bg-[var(--canvas)]",
        kept && "border-emerald-900 text-emerald-400",
        rejected && "border-red-950 text-red-400",
        active && "border-blue-900 text-blue-400",
      )}
    >
      {kept ? <Check className="size-3" /> : null}
      {rejected ? <X className="size-3" /> : null}
      {active ? <Circle className="size-2 fill-current" /> : null}
    </span>
  );
}

export function ExperimentTimeline({
  items,
  runHref,
}: {
  items: ExperimentDetailResource[];
  runHref: string;
}) {
  return (
    <ol className="relative">
      {items.map((experiment, index) => {
        const before = experiment.observations.find(
          (observation) => observation.kind === "before",
        );
        const after = experiment.observations.find(
          (observation) => observation.kind === "after",
        );
        const displayStatus =
          experiment.decision?.finalDecision ?? experiment.status;

        return (
          <li
            className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
            key={experiment.id}
          >
            {index < items.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-[11px] top-6 w-px bg-[var(--border)]"
              />
            ) : null}
            <DecisionIcon status={displayStatus} />
            <Panel className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
                <Link
                  className="font-mono text-xs font-medium text-[var(--text)] hover:underline"
                  href={`${runHref}/experiments/${experiment.id}`}
                >
                  Experiment {experiment.sequence}
                </Link>
                <StatusBadge
                  tone={
                    displayStatus === "kept"
                      ? "success"
                      : displayStatus === "discarded" ||
                          displayStatus === "failed"
                        ? "danger"
                        : "running"
                  }
                >
                  {displayStatus}
                </StatusBadge>
                <span className="ml-auto font-mono text-[10px] text-[var(--text-subtle)]">
                  {formatDuration(
                    experiment.startedAt,
                    experiment.completedAt,
                    experiment.estimatedDurationMs,
                  )}{" "}
                  · {new Date(experiment.createdAt).toLocaleDateString("en-US")}
                </span>
              </div>

              <div className="grid divide-y divide-[var(--border)] lg:grid-cols-[minmax(0,1fr)_240px] lg:divide-x lg:divide-y-0">
                <div className="p-4">
                  <div className="mb-4">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-subtle)]">
                      Hypothesis
                    </div>
                    <p className="text-[13px] leading-5 text-[var(--text)]">
                      {experiment.hypothesis}
                    </p>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-subtle)]">
                      Action
                    </div>
                    <p className="text-[12px] leading-5 text-[var(--text-muted)]">
                      {experiment.action}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 content-start">
                  <div className="border-b border-r border-[var(--border)] p-3">
                    <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                      Metric Before
                    </div>
                    <div className="mt-1 font-mono text-sm">
                      {formatMetric(before?.value)}
                    </div>
                  </div>
                  <div className="border-b border-[var(--border)] p-3">
                    <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                      Metric After
                    </div>
                    <div className="mt-1 font-mono text-sm">
                      {formatMetric(after?.value)}
                    </div>
                  </div>
                  <div className="col-span-2 p-3">
                    <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                      Learned Knowledge
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                      {experiment.learnings[0]?.statement ??
                        "No learning has been recorded."}
                    </p>
                  </div>
                </div>
              </div>
            </Panel>
          </li>
        );
      })}
    </ol>
  );
}
