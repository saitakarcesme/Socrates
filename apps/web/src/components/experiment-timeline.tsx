import { Check, Circle, X } from "lucide-react";
import Link from "next/link";

import { Panel, StatusBadge, cn } from "@socrates/design-system";

import type { ExperimentFixture } from "@/lib/fixtures";

function DecisionIcon({
  decision,
}: {
  decision: ExperimentFixture["decision"];
}) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border bg-[var(--canvas)]",
        decision === "kept" && "border-emerald-900 text-emerald-400",
        decision === "discarded" && "border-red-950 text-red-400",
        decision === "running" && "border-blue-900 text-blue-400",
      )}
    >
      {decision === "kept" ? <Check className="size-3" /> : null}
      {decision === "discarded" ? <X className="size-3" /> : null}
      {decision === "running" ? (
        <Circle className="size-2 fill-current" />
      ) : null}
    </span>
  );
}

export function ExperimentTimeline({
  items,
  runHref,
}: {
  items: ExperimentFixture[];
  runHref: string;
}) {
  return (
    <ol className="relative">
      {items.map((experiment, index) => (
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
          <DecisionIcon decision={experiment.decision} />
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
                  experiment.decision === "kept"
                    ? "success"
                    : experiment.decision === "discarded"
                      ? "danger"
                      : "running"
                }
              >
                {experiment.decision}
              </StatusBadge>
              <span className="ml-auto font-mono text-[10px] text-[var(--text-subtle)]">
                {experiment.duration} · {experiment.time}
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
                    {experiment.before}
                  </div>
                </div>
                <div className="border-b border-[var(--border)] p-3">
                  <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                    Metric After
                  </div>
                  <div className="mt-1 font-mono text-sm">
                    {experiment.after ?? "Running"}
                  </div>
                </div>
                <div className="col-span-2 p-3">
                  <div className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                    Learned Knowledge
                  </div>
                  <p className="mt-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                    {experiment.learnedKnowledge}
                  </p>
                </div>
              </div>
            </div>
          </Panel>
        </li>
      ))}
    </ol>
  );
}
