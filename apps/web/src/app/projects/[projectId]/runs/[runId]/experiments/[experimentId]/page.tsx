import { Check, Copy, ExternalLink, FileDiff } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { experiments, getExperiment, getRun, runs } from "@/lib/fixtures";

type ExperimentPageProps = {
  params: Promise<{
    projectId: string;
    runId: string;
    experimentId: string;
  }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return runs.flatMap((run) =>
    experiments
      .filter((experiment) => run.experimentIds.includes(experiment.id))
      .map((experiment) => ({
        projectId: run.projectId,
        runId: run.id,
        experimentId: experiment.id,
      })),
  );
}

export async function generateMetadata({
  params,
}: ExperimentPageProps): Promise<Metadata> {
  const { projectId, runId, experimentId } = await params;
  const experiment = getExperiment(projectId, runId, experimentId);

  if (!experiment) {
    return { title: "Experiment not found" };
  }

  return {
    title: `Experiment ${experiment.sequence}`,
    description: experiment.hypothesis,
  };
}

export default async function ExperimentPage({ params }: ExperimentPageProps) {
  const { projectId, runId, experimentId } = await params;
  const run = getRun(projectId, runId);
  const experiment = getExperiment(projectId, runId, experimentId);

  if (!run || !experiment) {
    notFound();
  }

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button disabled title="Clipboard actions are planned for Phase 1">
              <Copy className="size-3.5" />
              Copy ID
            </Button>
            <Button disabled title="Artifact storage is planned for Phase 1">
              <ExternalLink className="size-3.5" />
              Open artifact
            </Button>
          </div>
        }
        description={experiment.hypothesis}
        eyebrow={
          <span className="flex items-center gap-2">
            Run {run.number}{" "}
            <span className="text-[var(--text-subtle)]">/</span> Experiment{" "}
            {experiment.sequence}
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
          </span>
        }
        title={`Experiment ${experiment.sequence}`}
      />

      <div className="mx-auto max-w-5xl p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-4">
          <Metric label="Metric before" value={experiment.before} />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            label="Metric after"
            value={experiment.after ?? "Running"}
          />
          <Metric
            className="mt-5 border-t border-[var(--border)] pt-5 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            label="Delta"
            value={experiment.delta ?? "—"}
          />
          <Metric
            className="mt-5 border-l border-t border-[var(--border)] pl-5 pt-5 md:mt-0 md:border-t-0 md:pt-0"
            label="Duration"
            value={experiment.duration}
          />
        </section>

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
                <span className="ml-auto font-mono text-[10px] text-[var(--text-subtle)]">
                  2 files · +11 −4
                </span>
              </div>
              <p className="border-b border-[var(--border)] p-4 text-[13px] leading-6 text-[var(--text-muted)]">
                {experiment.action}
              </p>
              <div className="overflow-x-auto bg-[#090909] p-4 font-mono text-[11px] leading-5">
                <div className="text-[var(--text-subtle)]">app/layout.tsx</div>
                <div className="mt-2 text-emerald-400">
                  + &lt;link rel=&quot;preload&quot; as=&quot;image&quot;
                  href=&quot;/hero.webp&quot; /&gt;
                </div>
                <div className="text-emerald-400">
                  + fetchPriority=&quot;high&quot;
                </div>
              </div>
            </Panel>

            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Learned knowledge
              </div>
              <div className="flex gap-3 p-4">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-emerald-900 text-emerald-400">
                  <Check className="size-3" />
                </span>
                <p className="text-[13px] leading-6 text-[var(--text-muted)]">
                  {experiment.learnedKnowledge}
                </p>
              </div>
            </Panel>
          </div>

          <aside className="space-y-5">
            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Measurement
              </div>
              <dl className="divide-y divide-[var(--border)]">
                {[
                  ["Protocol", "LCP Mobile v3"],
                  ["Samples", experiment.after ? "3 / 3" : "2 / 3"],
                  ["Direction", "Minimize"],
                  ["Threshold", "−0.05s"],
                  ["Guardrails", "Passed"],
                  ["Environment", "runner-local-01"],
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
                  <div className="mt-1 text-[var(--text-muted)]">1f69c4a</div>
                </div>
                <div>
                  <div className="text-[var(--text-subtle)]">AFTER</div>
                  <div className="mt-1 text-[var(--text-muted)]">c31d8e2</div>
                </div>
                <div>
                  <div className="text-[var(--text-subtle)]">TASK</div>
                  <div className="mt-1 truncate text-[var(--text-muted)]">
                    tsk_01JYN5A8P4M
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
