import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { projects } from "@/lib/fixtures";

export const metadata: Metadata = {
  title: "Projects",
  description: "Optimization targets in the Socrates workspace.",
};

export default function ProjectsPage() {
  const activeProjects = projects.filter(
    (project) => project.status !== "completed",
  ).length;
  const totalExperiments = projects.reduce(
    (sum, project) => sum + Number(project.experimentCount),
    0,
  );

  return (
    <>
      <PageHeader
        actions={
          <Button disabled title="Project creation is planned for Phase 1">
            <Plus className="size-3.5" />
            New project
          </Button>
        }
        description="Define a measurable objective, then organize its runs, experiments, and knowledge."
        title="Projects"
      />

      <div className="mx-auto max-w-[1200px] p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-3">
          <Metric
            detail={`${projects.length - activeProjects} completed`}
            label="Active projects"
            value={String(activeProjects)}
          />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            detail="Across all runs"
            label="Experiments"
            value={String(totalExperiments)}
          />
          <Metric
            className="col-span-2 mt-5 border-t border-[var(--border)] pt-5 md:col-span-1 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            detail="1 currently executing"
            label="Runs"
            value="14"
          />
        </section>

        <div className="mb-4 mt-10">
          <h2 className="text-sm font-semibold">All projects</h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Ordered by most recent activity
          </p>
        </div>

        <Panel className="overflow-hidden">
          {projects.map((project) => (
            <Link
              className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(260px,1fr)_120px_120px_110px_24px] md:items-center"
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
                <span className="block font-mono text-xs">{project.best}</span>
                <span className="font-mono text-[10px] text-emerald-400">
                  {project.change}
                </span>
              </span>
              <span className="font-mono text-xs text-[var(--text-muted)]">
                {project.experimentCount} experiments
              </span>
              <StatusBadge
                tone={
                  project.status === "running"
                    ? "running"
                    : project.status === "paused"
                      ? "warning"
                      : "success"
                }
              >
                {project.status}
              </StatusBadge>
              <ArrowRight className="size-3.5 text-[var(--text-subtle)]" />
            </Link>
          ))}
        </Panel>
      </div>
    </>
  );
}
