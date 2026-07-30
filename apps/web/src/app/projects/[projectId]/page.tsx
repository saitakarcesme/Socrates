import { GitBranch, MoreHorizontal, Play, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { ControlPlaneError } from "@/lib/api/client";
import { getLearnings, getProject, getRuns } from "@/lib/api/queries";

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
};

export const dynamic = "force-dynamic";

async function loadProject(projectId: string) {
  try {
    return await getProject(projectId);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) notFound();
    throw error;
  }
}

function runTone(status: string) {
  if (["queued", "preparing", "running"].includes(status)) {
    return "running" as const;
  }
  if (["paused", "cancelling"].includes(status)) return "warning" as const;
  if (status === "completed") return "success" as const;
  if (["failed", "budget_exhausted"].includes(status)) {
    return "danger" as const;
  }
  return "neutral" as const;
}

function formatCost(minor: number) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
  }).format(minor / 100);
}

export async function generateMetadata({
  params,
}: ProjectPageProps): Promise<Metadata> {
  const { projectId } = await params;
  try {
    const project = await getProject(projectId);
    return { title: project.name, description: project.objective };
  } catch {
    return { title: "Project not found" };
  }
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const project = await loadProject(projectId);
  const [runs, learnings] = await Promise.all([
    getRuns(projectId),
    getLearnings(projectId),
  ]);
  const baselineRun = runs.find(({ baseline }) => baseline !== null);

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button
              aria-label="More project actions"
              disabled
              title="Additional project actions are not enabled"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
            <Button
              disabled
              title="Run creation form is being connected"
              variant="primary"
            >
              <Plus className="size-3.5" />
              New run
            </Button>
          </div>
        }
        description={project.objective}
        eyebrow={
          <span className="flex items-center gap-2">
            Projects <span className="text-[var(--text-subtle)]">/</span>{" "}
            {project.slug}
          </span>
        }
        title={project.name}
      />

      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <section className="grid gap-px overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-4">
          {(
            [
              [
                "Primary metric",
                project.currentMetric.name,
                `${project.currentMetric.direction} · ${project.currentMetric.unit}`,
              ],
              [
                "Protocol version",
                `v${project.currentMetric.version}`,
                `min ${project.currentMetric.minimumImprovement} ${project.currentMetric.unit}`,
              ],
              ["Runs", String(runs.length), "Bounded research sessions"],
              ["Knowledge", String(learnings.length), "Evidence-backed items"],
            ] satisfies Array<[string, string, string]>
          ).map(([label, value, detail]) => (
            <div className="bg-[var(--surface)] p-4" key={label}>
              <Metric detail={detail} label={label} value={value} />
            </div>
          ))}
        </section>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <div className="mb-4">
              <h2 className="text-sm font-semibold">Runs</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Bounded research sessions for this objective
              </p>
            </div>
            <Panel className="overflow-hidden">
              {runs.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <p className="text-sm">No runs for this project.</p>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    Create a run, record its baseline, then begin experimenting.
                  </p>
                </div>
              ) : (
                runs.map((run) => (
                  <Link
                    className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(180px,1fr)_110px_120px_130px] md:items-center"
                    href={`/projects/${projectId}/runs/${run.id}`}
                    key={run.id}
                  >
                    <span>
                      <span className="block font-mono text-xs">
                        Run {run.sequence}
                      </span>
                      <span className="mt-1 block truncate text-[10px] text-[var(--text-subtle)]">
                        {run.title}
                      </span>
                    </span>
                    <StatusBadge tone={runTone(run.status)}>
                      {run.status}
                    </StatusBadge>
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {run.baseline
                        ? `${run.baseline.amount} ${run.baseline.unit}`
                        : "No baseline"}
                    </span>
                    <span className="font-mono text-xs text-[var(--text-muted)]">
                      {formatCost(run.budget.maximumCostMinor)} max
                    </span>
                  </Link>
                ))
              )}
            </Panel>
          </section>

          <aside className="space-y-5">
            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Research protocol
              </div>
              <dl className="divide-y divide-[var(--border)]">
                {[
                  ["Source", project.source?.reference ?? "Manual"],
                  ["Metric", project.currentMetric.name],
                  ["Direction", project.currentMetric.direction],
                  [
                    "Minimum change",
                    `${project.currentMetric.minimumImprovement} ${project.currentMetric.unit}`,
                  ],
                  [
                    "Noise tolerance",
                    `${project.currentMetric.noiseTolerance} ${project.currentMetric.unit}`,
                  ],
                  [
                    "Guardrails",
                    String(project.currentMetric.guardrails.length),
                  ],
                ].map(([term, value]) => (
                  <div
                    className="flex justify-between gap-4 px-4 py-3"
                    key={term}
                  >
                    <dt className="text-xs text-[var(--text-subtle)]">
                      {term}
                    </dt>
                    <dd className="max-w-[190px] truncate text-right font-mono text-[11px] text-[var(--text-muted)]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel className="p-4">
              <div className="flex items-center gap-2 text-xs font-medium">
                <GitBranch className="size-3.5 text-[var(--text-muted)]" />
                Latest baseline
              </div>
              <div className="mt-4 font-mono text-2xl">
                {baselineRun?.baseline
                  ? `${baselineRun.baseline.amount} ${baselineRun.baseline.unit}`
                  : "—"}
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                {baselineRun
                  ? `Frozen for run ${baselineRun.sequence}.`
                  : "No baseline has been recorded yet."}
              </p>
              <Button
                className="mt-4 w-full"
                disabled
                size="sm"
                title="Baseline artifacts are not available"
              >
                <Play className="size-3" />
                View baseline
              </Button>
            </Panel>
          </aside>
        </div>
      </div>
    </>
  );
}
