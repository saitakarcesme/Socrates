import { MoreHorizontal } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { ExperimentTimeline } from "@/components/experiment-timeline";
import { RunSetupControls } from "@/components/forms/run-setup-controls";
import { RunLifecycleActions } from "@/components/forms/run-lifecycle-actions";
import { ProposeExperimentForm } from "@/components/forms/propose-experiment-form";
import { PageHeader } from "@/components/page-header";
import { RunEventReconciler } from "@/components/run-event-reconciler";
import { ControlPlaneError } from "@/lib/api/client";
import {
  getExperiments,
  getLearnings,
  getProject,
  getRun,
} from "@/lib/api/queries";
import {
  formatDuration,
  formatMetric,
  selectBestMetric,
} from "@/lib/metric-presentation";

type RunPageProps = {
  params: Promise<{ projectId: string; runId: string }>;
};

export const dynamic = "force-dynamic";

async function loadRun(projectId: string, runId: string) {
  try {
    const [project, run, experiments, learnings] = await Promise.all([
      getProject(projectId),
      getRun(runId),
      getExperiments(runId),
      getLearnings(projectId),
    ]);

    if (run.projectId !== projectId) {
      notFound();
    }

    return { project, run, experiments, learnings };
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) {
      notFound();
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: RunPageProps): Promise<Metadata> {
  const { projectId, runId } = await params;
  const { run } = await loadRun(projectId, runId);

  return {
    title: `Run ${run.sequence} · ${run.title}`,
    description: run.objective,
  };
}

export default async function RunPage({ params }: RunPageProps) {
  const { projectId, runId } = await params;
  const { project, run, experiments, learnings } = await loadRun(
    projectId,
    runId,
  );
  const runHref = `/projects/${projectId}/runs/${runId}`;
  const latestAfter = experiments
    .flatMap((experiment) =>
      experiment.observations.filter(
        (observation) => observation.kind === "after",
      ),
    )
    .at(0)?.value;
  const best = selectBestMetric(
    run.baseline,
    experiments,
    run.metricDefinition.direction,
  );
  const estimatedCost = experiments.reduce(
    (total, experiment) => total + experiment.estimatedCostMinor,
    0,
  );
  const budgetPercent =
    run.budget.maximumCostMinor > 0
      ? Math.min(
          100,
          Math.round((estimatedCost / run.budget.maximumCostMinor) * 100),
        )
      : 0;
  const openExperiments = experiments.filter(
    ({ status }) =>
      !["kept", "discarded", "inconclusive", "failed"].includes(status),
  ).length;

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
            <RunLifecycleActions openExperiments={openExperiments} run={run} />
          </div>
        }
        description={run.objective}
        eyebrow={
          <span className="flex items-center gap-2">
            {project.name} <span className="text-[var(--text-subtle)]">/</span>{" "}
            Run {run.sequence}
            <StatusBadge
              tone={
                run.status === "running"
                  ? "running"
                  : run.status === "failed" ||
                      run.status === "cancelled" ||
                      run.status === "budget_exhausted"
                    ? "danger"
                    : run.status === "completed"
                      ? "success"
                      : "neutral"
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
          <RunSetupControls run={run} unit={run.metricDefinition.unit} />
          <ProposeExperimentForm projectId={projectId} run={run} />
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold">Experiment timeline</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {experiments.length} experiments · newest first
              </p>
            </div>
            <RunEventReconciler
              initialSequence={run.latestEventSequence}
              runId={run.id}
            />
          </div>
          {experiments.length > 0 ? (
            <ExperimentTimeline items={experiments} runHref={runHref} />
          ) : (
            <Panel className="flex min-h-52 items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-subtle)]">
                  No experiments
                </div>
                <p className="mt-3 text-sm text-[var(--text)]">
                  This run has no proposed experiments yet.
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                  Experiments will appear here as the control plane records
                  hypotheses, observations, decisions, and learnings.
                </p>
              </div>
            </Panel>
          )}
        </section>

        <aside className="space-y-0 xl:sticky xl:top-0 xl:h-screen xl:overflow-y-auto">
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric
                detail={`v${run.metricDefinition.version} · ${run.metricDefinition.name}`}
                label="Current metric"
                value={formatMetric(latestAfter ?? run.baseline)}
              />
            </div>
            <div className="p-4">
              <Metric
                detail={run.metricDefinition.direction}
                label="Best result"
                value={formatMetric(best)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric
                detail="observed wall-clock"
                label="Elapsed time"
                value={formatDuration(
                  run.startedAt,
                  run.completedAt ?? run.updatedAt,
                )}
              />
            </div>
            <div className="p-4">
              <Metric
                detail="estimated minor units"
                label="Budget"
                value={`${estimatedCost} / ${run.budget.maximumCostMinor}`}
              />
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Budget usage</h3>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {budgetPercent}%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-[2px] bg-neutral-900">
              <div
                className="h-full bg-neutral-400"
                style={{ width: `${budgetPercent}%` }}
              />
            </div>
            <div className="mt-3 flex justify-between font-mono text-[10px] text-[var(--text-subtle)]">
              <span>
                {experiments.length} / {run.budget.maximumExperiments}{" "}
                experiments
              </span>
              <span>{run.status}</span>
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Knowledge</h3>
              <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                {learnings.length} items
              </span>
            </div>
            {learnings.length > 0 ? (
              <div className="space-y-3">
                {learnings.slice(0, 3).map((learning) => (
                  <div className="flex gap-2.5" key={learning.id}>
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-neutral-500" />
                    <p className="text-[11px] leading-[17px] text-[var(--text-muted)]">
                      {learning.statement}
                    </p>
                    <span className="ml-auto font-mono text-[9px] text-[var(--text-subtle)]">
                      {learning.confidence.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] leading-[17px] text-[var(--text-muted)]">
                No durable knowledge has been recorded for this project.
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
