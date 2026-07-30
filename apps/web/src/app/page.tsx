import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { projects } from "@/lib/fixtures";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        actions={
          <Button variant="primary">
            <Plus className="size-3.5" />
            New project
          </Button>
        }
        description="Monitor active optimization work and the knowledge it produces."
        title="Dashboard"
      />

      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-4">
          <Metric label="Active runs" value="2" detail="Across 3 projects" />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            label="Experiments"
            value="49"
            detail="12 accepted"
          />
          <Metric
            className="mt-5 border-t border-[var(--border)] pt-5 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            label="Compute today"
            value="$18.42"
            detail="61% of daily budget"
          />
          <Metric
            className="mt-5 border-l border-t border-[var(--border)] pl-5 pt-5 md:mt-0 md:border-t-0 md:pt-0"
            label="Learnings"
            value="27"
            detail="4 added this week"
          />
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Projects</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Optimization targets in this workspace
              </p>
            </div>
            <button className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
              View all
            </button>
          </div>

          <Panel className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(260px,1fr)_120px_100px_80px_110px_32px] gap-4 border-b border-[var(--border)] px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-subtle)] md:grid">
              <span>Project</span>
              <span>Metric</span>
              <span>Best</span>
              <span>Runs</span>
              <span>Status</span>
              <span />
            </div>
            {projects.map((project) => (
              <Link
                className="grid gap-4 border-b border-[var(--border)] px-4 py-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(260px,1fr)_120px_100px_80px_110px_32px] md:items-center"
                href={`/projects/${project.id}`}
                key={project.id}
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">
                    {project.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">
                    {project.objective}
                  </span>
                </span>
                <span className="font-mono text-xs text-[var(--text-muted)]">
                  {project.metric}
                </span>
                <span>
                  <span className="block font-mono text-xs">
                    {project.best}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-emerald-400">
                    {project.change}
                  </span>
                </span>
                <span className="font-mono text-xs text-[var(--text-muted)]">
                  {project.runs}
                </span>
                <StatusBadge
                  tone={
                    project.status === "running"
                      ? "running"
                      : project.status === "completed"
                        ? "success"
                        : "warning"
                  }
                >
                  {project.status}
                </StatusBadge>
                <ArrowRight className="size-3.5 text-[var(--text-subtle)]" />
              </Link>
            ))}
          </Panel>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-2">
          <Panel>
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-xs font-medium">Recent activity</h2>
            </div>
            {[
              ["Experiment 42 started", "Atlas Web", "2 min ago"],
              ["Experiment 41 accepted", "Atlas Web", "11 min ago"],
              ["Run 4 paused", "Meridian Eval", "3 hr ago"],
              ["Learning confidence changed", "Northstar Data", "Yesterday"],
            ].map(([event, project, time]) => (
              <div
                className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 last:border-0"
                key={event}
              >
                <span className="size-1.5 rounded-full bg-neutral-500" />
                <span className="text-xs">{event}</span>
                <span className="text-xs text-[var(--text-subtle)]">
                  {project}
                </span>
                <span className="ml-auto font-mono text-[10px] text-[var(--text-subtle)]">
                  {time}
                </span>
              </div>
            ))}
          </Panel>

          <Panel>
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-xs font-medium">Budget</h2>
            </div>
            <div className="p-4">
              <div className="flex items-end justify-between">
                <div>
                  <div className="font-mono text-lg">$18.42</div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    of $30.00 daily limit
                  </div>
                </div>
                <div className="font-mono text-xs text-[var(--text-muted)]">
                  61%
                </div>
              </div>
              <div className="mt-4 h-1 overflow-hidden rounded-[2px] bg-neutral-900">
                <div className="h-full w-[61%] bg-neutral-400" />
              </div>
              <div className="mt-5 grid grid-cols-3 gap-4 border-t border-[var(--border)] pt-4">
                <Metric label="Model" value="$8.70" />
                <Metric label="Compute" value="$9.72" />
                <Metric label="Forecast" value="$26.10" />
              </div>
            </div>
          </Panel>
        </section>
      </div>
    </>
  );
}
