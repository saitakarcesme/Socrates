import { GitBranch, MoreHorizontal, Play, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { getProject, getRunsForProject, projects } from "@/lib/fixtures";

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return projects.map((project) => ({ projectId: project.id }));
}

export async function generateMetadata({
  params,
}: ProjectPageProps): Promise<Metadata> {
  const { projectId } = await params;
  const project = getProject(projectId);

  if (!project) {
    return { title: "Project not found" };
  }

  return {
    title: project.name,
    description: project.description,
  };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const project = getProject(projectId);

  if (!project) {
    notFound();
  }

  const projectRuns = getRunsForProject(projectId);

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button
              aria-label="More project actions"
              disabled
              title="Project actions are planned for Phase 1"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
            <Button
              disabled
              title="Run creation is planned for Phase 1"
              variant="primary"
            >
              <Plus className="size-3.5" />
              New run
            </Button>
          </div>
        }
        description={project.description}
        eyebrow={
          <span className="flex items-center gap-2">
            Projects <span className="text-[var(--text-subtle)]">/</span>{" "}
            {projectId}
          </span>
        }
        title={project.name}
      />

      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <section className="grid gap-px overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-4">
          {(
            [
              ["Primary metric", project.best, project.metric],
              [
                "Improvement",
                project.change,
                `from ${project.baseline} baseline`,
              ],
              ["Experiments", project.experimentCount, `${project.runs} runs`],
              ["Knowledge", project.learningCount, "Evidence-backed items"],
            ] as const
          ).map(([label, value, detail]) => (
            <div className="bg-[var(--surface)] p-4" key={label}>
              <Metric detail={detail} label={label} value={value} />
            </div>
          ))}
        </section>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Runs</h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Bounded research sessions for this objective
                </p>
              </div>
            </div>
            <Panel className="overflow-hidden">
              {projectRuns.map((run) => (
                <Link
                  className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(130px,1fr)_100px_110px_110px_100px] md:items-center"
                  href={`/projects/${projectId}/runs/${run.id}`}
                  key={run.id}
                >
                  <span>
                    <span className="block font-mono text-xs">
                      Run {run.number}
                    </span>
                    <span className="mt-1 block text-[10px] text-[var(--text-subtle)]">
                      {run.time}
                    </span>
                  </span>
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
                  <span>
                    <span className="block font-mono text-xs">
                      {run.metric}
                    </span>
                    <span className="font-mono text-[10px] text-emerald-400">
                      {run.change}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {run.experiments}
                  </span>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {run.budget}
                  </span>
                </Link>
              ))}
            </Panel>
          </section>

          <aside className="space-y-5">
            <Panel>
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs font-medium">
                Research protocol
              </div>
              <dl className="divide-y divide-[var(--border)]">
                {project.protocol.map(([term, value]) => (
                  <div
                    className="flex justify-between gap-4 px-4 py-3"
                    key={term}
                  >
                    <dt className="text-xs text-[var(--text-subtle)]">
                      {term}
                    </dt>
                    <dd className="text-right font-mono text-[11px] text-[var(--text-muted)]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel className="p-4">
              <div className="flex items-center gap-2 text-xs font-medium">
                <GitBranch className="size-3.5 text-[var(--text-muted)]" />
                Baseline
              </div>
              <div className="mt-4 font-mono text-2xl">{project.baseline}</div>
              <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                Recorded on commit 9e42a1c with protocol v3.
              </p>
              <Button
                className="mt-4 w-full"
                disabled
                size="sm"
                title="Baseline artifacts are planned for Phase 1"
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
