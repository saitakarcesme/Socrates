import { ArrowRight, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  Metric,
  Panel,
  StatusBadge,
  buttonClassName,
} from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { getProjects } from "@/lib/api/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Projects",
  description: "Optimization targets in the Socrates workspace.",
};

function projectTone(status: string) {
  if (status === "active") return "running" as const;
  if (status === "paused") return "warning" as const;
  if (status === "completed") return "success" as const;
  return "neutral" as const;
}

export default async function ProjectsPage() {
  const projects = await getProjects();
  const activeProjects = projects.filter(
    ({ status }) => status === "active",
  ).length;

  return (
    <>
      <PageHeader
        actions={
          <Link
            className={buttonClassName({ variant: "primary" })}
            href="/projects/new"
          >
            <Plus className="size-3.5" />
            New project
          </Link>
        }
        description="Define a measurable objective, then organize its runs, experiments, and knowledge."
        title="Projects"
      />

      <div className="mx-auto max-w-[1200px] p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-3">
          <Metric
            detail={`${projects.length - activeProjects} inactive`}
            label="Active projects"
            value={String(activeProjects)}
          />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            detail="Workspace total"
            label="Projects"
            value={String(projects.length)}
          />
          <Metric
            className="col-span-2 mt-5 border-t border-[var(--border)] pt-5 md:col-span-1 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            detail="Versioned definitions"
            label="Metric protocols"
            value={String(projects.length)}
          />
        </section>

        <div className="mb-4 mt-10">
          <h2 className="text-sm font-semibold">All projects</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Ordered by most recent creation
          </p>
        </div>

        <Panel className="overflow-hidden">
          {projects.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm">No projects found.</p>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                A project starts with one objective and one measurable protocol.
              </p>
            </div>
          ) : (
            projects.map((project) => (
              <Link
                className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(260px,1fr)_180px_110px_24px] md:items-center"
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
                <span>
                  <span className="block font-mono text-xs">
                    {project.currentMetric.name}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                    {project.currentMetric.direction} ·{" "}
                    {project.currentMetric.unit}
                  </span>
                </span>
                <StatusBadge tone={projectTone(project.status)}>
                  {project.status}
                </StatusBadge>
                <ArrowRight className="size-3.5 text-[var(--text-subtle)]" />
              </Link>
            ))
          )}
        </Panel>
      </div>
    </>
  );
}
