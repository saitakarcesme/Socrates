import { Filter, Search } from "lucide-react";
import type { Metadata } from "next";

import { Button, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { getProjects, getWorkspaceLearnings } from "@/lib/api/queries";

export const metadata: Metadata = {
  title: "Learnings",
  description: "Evidence-backed knowledge accumulated by Socrates.",
};

export const dynamic = "force-dynamic";

export default async function LearningsPage() {
  const [learnings, projects] = await Promise.all([
    getWorkspaceLearnings(),
    getProjects(),
  ]);
  const projectNames = new Map(
    projects.map((project) => [project.id, project.name]),
  );

  return (
    <>
      <PageHeader
        description="Evidence-backed knowledge accumulated across projects and runs."
        title="Learnings"
      />

      <div className="mx-auto max-w-[1200px] p-6 sm:p-8">
        <div className="mb-6 flex gap-2">
          <label className="flex h-8 flex-1 items-center gap-2 rounded-[4px] border border-[var(--border)] bg-[var(--surface)] px-3">
            <Search className="size-3.5 text-[var(--text-subtle)]" />
            <input
              aria-label="Search learnings"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--text-subtle)] disabled:cursor-not-allowed"
              disabled
              placeholder="Search accumulated knowledge"
              title="Learning search is not available yet"
            />
          </label>
          <Button disabled title="Learning filters are not available yet">
            <Filter className="size-3.5" />
            Filter
          </Button>
        </div>

        <div className="mb-3 grid grid-cols-[1fr_120px_100px] gap-4 px-4 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-subtle)]">
          <span>Knowledge</span>
          <span>Confidence</span>
          <span>Updated</span>
        </div>
        <Panel className="overflow-hidden">
          {learnings.length > 0 ? (
            learnings.map((learning) => (
              <article
                className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[1fr_120px_100px]"
                key={learning.id}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-[3px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-subtle)]">
                      {projectNames.get(learning.projectId) ??
                        "Unknown project"}
                    </span>
                    <span className="font-mono text-[9px] uppercase text-[var(--text-subtle)]">
                      {learning.status}
                    </span>
                  </div>
                  <p className="mt-2 max-w-3xl text-[13px] leading-6 text-[var(--text)]">
                    {learning.statement}
                  </p>
                </div>
                <div>
                  <StatusBadge
                    tone={learning.confidence >= 0.8 ? "success" : "warning"}
                  >
                    {learning.confidence.toFixed(2)}
                  </StatusBadge>
                </div>
                <time
                  className="font-mono text-[10px] text-[var(--text-subtle)]"
                  dateTime={learning.updatedAt}
                >
                  {new Date(learning.updatedAt).toLocaleDateString("en-US")}
                </time>
              </article>
            ))
          ) : (
            <div className="p-10 text-center">
              <p className="text-sm text-[var(--text)]">
                No knowledge has been recorded.
              </p>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Evidence-backed learnings will accumulate here after measured
                experiments.
              </p>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
