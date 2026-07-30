import { MoreHorizontal, Pause, Square } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { ExperimentTimeline } from "@/components/experiment-timeline";
import { PageHeader } from "@/components/page-header";
import {
  getExperimentsForRun,
  getProject,
  getRun,
  learnings,
  runs,
} from "@/lib/fixtures";

type RunPageProps = {
  params: Promise<{ projectId: string; runId: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return runs.map((run) => ({
    projectId: run.projectId,
    runId: run.id,
  }));
}

export async function generateMetadata({
  params,
}: RunPageProps): Promise<Metadata> {
  const { projectId, runId } = await params;
  const run = getRun(projectId, runId);

  if (!run) {
    return { title: "Run not found" };
  }

  return {
    title: `Run ${run.number} · ${run.title}`,
    description: run.description,
  };
}

export default async function RunPage({ params }: RunPageProps) {
  const { projectId, runId } = await params;
  const project = getProject(projectId);
  const run = getRun(projectId, runId);

  if (!project || !run) {
    notFound();
  }

  const runExperiments = getExperimentsForRun(projectId, runId);
  const projectLearnings = learnings
    .filter((learning) => learning.project === project.name)
    .slice(0, 3);
  const runHref = `/projects/${projectId}/runs/${runId}`;

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button
              aria-label="More run actions"
              disabled
              title="Run actions are planned for Phase 1"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
            <Button disabled title="Run control is planned for Phase 2">
              <Pause className="size-3.5" />
              Pause
            </Button>
            <Button
              disabled
              title="Run control is planned for Phase 2"
              variant="danger"
            >
              <Square className="size-3" />
              Stop
            </Button>
          </div>
        }
        description={run.description}
        eyebrow={
          <span className="flex items-center gap-2">
            {project.name} <span className="text-[var(--text-subtle)]">/</span>{" "}
            Run {run.number}
            <StatusBadge
              tone={
                run.status === "running"
                  ? "running"
                  : run.status === "paused"
                    ? "warning"
                    : "success"
              }
            >
              {run.status}
            </StatusBadge>
          </span>
        }
        title={run.title}
      />

      <div className="mx-auto grid max-w-[1560px] xl:grid-cols-[minmax(0,1fr)_304px]">
        <section className="min-w-0 p-6 sm:p-8 xl:border-r xl:border-[var(--border)]">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h2 className="text-sm font-semibold">Experiment timeline</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {run.experiments} experiments · newest first
              </p>
            </div>
            <button
              className="text-xs text-[var(--text-muted)] disabled:opacity-40"
              disabled
              title="Timeline filters are planned for Phase 1"
              type="button"
            >
              Filter
            </button>
          </div>
          {runExperiments.length > 0 ? (
            <ExperimentTimeline items={[...runExperiments]} runHref={runHref} />
          ) : (
            <Panel className="flex min-h-52 items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-subtle)]">
                  Historical run
                </div>
                <p className="mt-3 text-sm text-[var(--text)]">
                  Experiment details are not included in this skeleton fixture.
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                  The route and run summary remain available to demonstrate the
                  complete navigation model.
                </p>
              </div>
            </Panel>
          )}
        </section>

        <aside className="space-y-0 xl:sticky xl:top-0 xl:h-screen xl:overflow-y-auto">
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric
                detail={project.metric}
                label="Current metric"
                value={run.metric}
              />
            </div>
            <div className="p-4">
              <Metric
                detail={`${project.change} overall`}
                label="Best result"
                value={project.best}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric
                detail="wall-clock"
                label="Elapsed time"
                value={run.time}
              />
            </div>
            <div className="p-4">
              <Metric
                detail="consumed / limit"
                label="Budget"
                value={run.budget}
              />
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Budget usage</h3>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                40%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-[2px] bg-neutral-900">
              <div className="h-full w-[40%] bg-neutral-400" />
            </div>
            <div className="mt-3 flex justify-between font-mono text-[10px] text-[var(--text-subtle)]">
              <span>{run.experiments} experiments</span>
              <span>{run.status}</span>
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Knowledge</h3>
              <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                {projectLearnings.length} items
              </span>
            </div>
            <div className="space-y-3">
              {projectLearnings.map((learning) => (
                <div className="flex gap-2.5" key={learning.title}>
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-neutral-500" />
                  <p className="text-[11px] leading-[17px] text-[var(--text-muted)]">
                    {learning.summary}
                  </p>
                  <span className="ml-auto font-mono text-[9px] text-[var(--text-subtle)]">
                    {learning.confidence === "High" ? "0.9" : "0.7"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <Panel className="m-4 p-3">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-blue-400" />
              <span className="text-[11px] font-medium">Runner local-01</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[9px] text-[var(--text-subtle)]">
              <span>CPU 38%</span>
              <span>MEM 1.8 GB</span>
              <span>Node 22.17</span>
              <span>Lease 28s</span>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
