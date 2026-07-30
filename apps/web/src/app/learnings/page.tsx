import { Filter, Search } from "lucide-react";
import type { Metadata } from "next";

import { Button, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";
import { learnings } from "@/lib/fixtures";

export const metadata: Metadata = {
  title: "Learnings",
  description: "Evidence-backed knowledge accumulated by Socrates.",
};

export default function LearningsPage() {
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
              title="Learning search is planned for Phase 1"
            />
          </label>
          <Button disabled title="Learning filters are planned for Phase 1">
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
          {learnings.map((learning) => (
            <article
              className="grid gap-4 border-b border-[var(--border)] p-4 last:border-0 hover:bg-[var(--surface-hover)] md:grid-cols-[1fr_120px_100px]"
              key={learning.title}
            >
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[13px] font-medium">{learning.title}</h2>
                  <span className="rounded-[3px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-subtle)]">
                    {learning.project}
                  </span>
                </div>
                <p className="mt-2 max-w-3xl text-xs leading-5 text-[var(--text-muted)]">
                  {learning.summary}
                </p>
                <div className="mt-3 font-mono text-[10px] text-[var(--text-subtle)]">
                  Evidence: {learning.evidence}
                </div>
              </div>
              <div>
                <StatusBadge
                  tone={learning.confidence === "High" ? "success" : "warning"}
                >
                  {learning.confidence}
                </StatusBadge>
              </div>
              <div className="font-mono text-[10px] text-[var(--text-subtle)]">
                {learning.updated}
              </div>
            </article>
          ))}
        </Panel>
      </div>
    </>
  );
}
