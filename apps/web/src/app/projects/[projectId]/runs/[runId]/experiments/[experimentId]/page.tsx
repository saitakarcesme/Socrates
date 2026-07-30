import { Check, FileDiff } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { ExperimentWorkflowControls } from "@/components/forms/experiment-workflow-controls";
import { ControlPlaneError } from "@/lib/api/client";
import { getExperiment, getRun } from "@/lib/api/queries";
import { formatDuration, formatMetric } from "@/lib/metric-presentation";

type ExperimentPageProps = {
  params: Promise<{
    projectId: string;
    runId: string;
    experimentId: string;
  }>;
};

export const dynamic = "force-dynamic";

async function loadExperiment(
  projectId: string,
  runId: string,
  experimentId: string,
) {
  try {
    const [run, experiment] = await Promise.all([
      getRun(runId),
      getExperiment(experimentId),
    ]);

    if (run.projectId !== projectId || experiment.runId !== runId) {
      notFound();
    }

    return { run, experiment };
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) {
      notFound();
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: ExperimentPageProps): Promise<Metadata> {
  const { projectId, runId, experimentId } = await params;
  const { experiment } = await loadExperiment(projectId, runId, experimentId);

  return {
    title: `Experiment ${experiment.sequence}`,
    description: experiment.hypothesis,
  };
}

export default async function ExperimentPage({ params }: ExperimentPageProps) {
  const { projectId, runId, experimentId } = await params;
  const { run, experiment } = await loadExperiment(
    projectId,
    runId,
    experimentId,
  );
  const before = experiment.observations.find(
    (observation) => observation.kind === "before",
  );
  const after = experiment.observations.find(
    (observation) => observation.kind === "after",
  );
  const guardrailObservations = experiment.observations.filter(
    (observation) => observation.kind === "guardrail",
  );
  const displayStatus = experiment.decision?.finalDecision ?? experiment.status;

  return (
    <>
      <PageHeader
        description={experiment.hypothesis}
        eyebrow={
          <span className="flex items-center gap-2">
            Run {run.sequence}{" "}
            <span className="text-[var(--text-subtle)]">/</span> Experiment{" "}
            {experiment.sequence}
            <StatusBadge
              tone={
                displayStatus === "kept"
                  ? "success"
                  : displayStatus === "discarded" || displayStatus === "failed"
                    ? "danger"
                    : "running"
              }
            >
              {displayStatus}
            </StatusBadge>
          </span>
        }
        title={`Experiment ${experiment.sequence}`}
      />

      <div className="mx-auto max-w-5xl p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-4">
          <Metric label="Metric before" value={formatMetric(before?.value)} />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            label="Metric after"
            value={formatMetric(after?.value)}
          />
          <Metric
            className="mt-5 border-t border-[var(--border)] pt-5 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            detail={run.metricDefinition.unit}
            label="Improvement"
            value={experiment.decision?.calculatedImprovement ?? "Pending"}
          />
          <Metric
            className="mt-5 border-l border-t border-[var(--border)] pl-5 pt-5 md:mt-0 md:border-t-0 md:pt-0"
            label="Duration"
            value={formatDuration(
              experiment.startedAt,
              experiment.completedAt,
              experiment.estimatedDurationMs,
            )}
          />
        </section>

        <div className="mt-6">
          <ExperimentWorkflowControls
            experiment={experiment}
            metricDefinition={run.metricDefinition}
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-6">
            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Hypothesis
              </div>
              <p className="p-4 text-[13px] leading-6 text-[var(--text-muted)]">
                {experiment.hypothesis}
              </p>
            </Panel>

            <Panel>
              <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                <FileDiff className="size-3.5 text-[var(--text-muted)]" />
                Action
              </div>
              <p className="p-4 text-[13px] leading-6 text-[var(--text-muted)]">
                {experiment.action}
              </p>
            </Panel>

            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Decision
              </div>
              <div className="grid gap-px bg-[var(--border)] sm:grid-cols-2">
                <div className="bg-[var(--surface)] p-4">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                    Result
                  </div>
                  <div className="mt-2 font-mono text-xs">
                    {experiment.decision?.finalDecision ?? "Pending"}
                  </div>
                </div>
                <div className="bg-[var(--surface)] p-4">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                    Reason
                  </div>
                  <div className="mt-2 font-mono text-xs">
                    {experiment.decision?.overrideReason ??
                      experiment.decision?.reason ??
                      "Awaiting measurement"}
                  </div>
                </div>
              </div>
            </Panel>

            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Learned knowledge
              </div>
              {experiment.learnings.length > 0 ? (
                <div className="divide-y divide-[var(--border)]">
                  {experiment.learnings.map((learning) => (
                    <div className="flex gap-3 p-4" key={learning.id}>
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-emerald-900 text-emerald-400">
                        <Check className="size-3" />
                      </span>
                      <div>
                        <p className="text-[13px] leading-6 text-[var(--text-muted)]">
                          {learning.statement}
                        </p>
                        <p className="mt-1 font-mono text-[9px] uppercase text-[var(--text-subtle)]">
                          {learning.evidenceRole} · confidence{" "}
                          {learning.confidence.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="p-4 text-[13px] text-[var(--text-muted)]">
                  No durable learning has been linked to this experiment.
                </p>
              )}
            </Panel>
          </div>

          <aside className="space-y-5">
            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Measurement
              </div>
              <dl className="divide-y divide-[var(--border)]">
                {[
                  ["Protocol", `v${run.metricDefinition.version}`],
                  [
                    "Samples",
                    String(
                      experiment.observations.reduce(
                        (total, observation) => total + observation.sampleCount,
                        0,
                      ),
                    ),
                  ],
                  ["Direction", run.metricDefinition.direction],
                  [
                    "Threshold",
                    `${run.metricDefinition.minimumImprovement} ${run.metricDefinition.unit}`,
                  ],
                  [
                    "Guardrails",
                    `${guardrailObservations.length} / ${run.metricDefinition.guardrails.length} measured`,
                  ],
                  ["Policy", experiment.decision?.policyVersion ?? "Pending"],
                ].map(([term, value]) => (
                  <div
                    className="flex justify-between gap-3 px-4 py-3"
                    key={term}
                  >
                    <dt className="text-[11px] text-[var(--text-subtle)]">
                      {term}
                    </dt>
                    <dd className="text-right font-mono text-[10px] text-[var(--text-muted)]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Provenance
              </div>
              <div className="space-y-3 p-4 font-mono text-[10px]">
                <div>
                  <div className="text-[var(--text-subtle)]">BEFORE</div>
                  <div className="mt-1 break-all text-[var(--text-muted)]">
                    {before?.id ?? "Not recorded"}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--text-subtle)]">AFTER</div>
                  <div className="mt-1 break-all text-[var(--text-muted)]">
                    {after?.id ?? "Not recorded"}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--text-subtle)]">EXPERIMENT</div>
                  <div className="mt-1 break-all text-[var(--text-muted)]">
                    {experiment.id}
                  </div>
                </div>
              </div>
            </Panel>
          </aside>
        </div>
      </div>
    </>
  );
}
