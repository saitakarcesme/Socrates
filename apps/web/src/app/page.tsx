import { ArrowRight, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { getProjects } from "@/lib/api/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Monitor active optimization work in Socrates.",
};

function projectTone(status: string) {
  if (status === "active") return "running" as const;
  if (status === "paused") return "warning" as const;
  if (status === "completed") return "success" as const;
  return "neutral" as const;
}

export default async function DashboardPage() {
  const projects = await getProjects();
  const activeProjects = projects.filter(
    ({ status }) => status === "active",
  ).length;
  const latestUpdate = projects
    .map(({ updatedAt }) => updatedAt)
    .sort()
    .at(-1);

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled
            title="Project creation form is being connected"
            variant="primary"
          >
            <Plus className="size-3.5" />
            New project
          </Button>
        }
        description="Monitor active optimization work and the knowledge it produces."
        title="Dashboard"
      />

      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <section className="grid grid-cols-2 border-y border-[var(--border)] py-5 md:grid-cols-4">
          <Metric
            detail={`${projects.length - activeProjects} inactive`}
            label="Active projects"
            value={String(activeProjects)}
          />
          <Metric
            className="border-l border-[var(--border)] pl-5"
            detail="Immutable metric definitions"
            label="Protocols"
            value={String(projects.length)}
          />
          <Metric
            className="mt-5 border-t border-[var(--border)] pt-5 md:mt-0 md:border-l md:border-t-0 md:pl-5 md:pt-0"
            detail="Workspace total"
            label="Projects"
            value={String(projects.length)}
          />
          <Metric
            className="mt-5 border-l border-t border-[var(--border)] pl-5 pt-5 md:mt-0 md:border-t-0 md:pt-0"
            detail={latestUpdate ? latestUpdate.slice(0, 10) : "No activity"}
            label="Last update"
            value={latestUpdate ? latestUpdate.slice(11, 16) : "—"}
          />
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Projects</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Measured optimization targets in this workspace
              </p>
            </div>
            <Link
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
              href="/projects"
            >
              View all
            </Link>
          </div>

          <Panel className="overflow-hidden">
            {projects.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="text-sm">No measured projects yet.</p>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Create a project to define the first objective and metric.
                </p>
              </div>
            ) : (
              projects.map((project) => (
                <Link
                  className="grid gap-4 border-b border-[var(--border)] px-4 py-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[minmax(260px,1fr)_160px_120px_32px] md:items-center"
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
                    <span className="mt-0.5 block font-mono text-[10px] text-[var(--text-subtle)]">
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
        </section>
      </div>
    </>
  );
}
