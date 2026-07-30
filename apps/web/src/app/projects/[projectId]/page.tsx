import { GitBranch, MoreHorizontal, Play, Plus } from "lucide-react";
import Link from "next/link";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button aria-label="More project actions">
              <MoreHorizontal className="size-3.5" />
            </Button>
            <Button variant="primary">
              <Plus className="size-3.5" />
              New run
            </Button>
          </div>
        }
        description="Reduce p75 Largest Contentful Paint without regressing conversion."
        eyebrow={
          <span className="flex items-center gap-2">
            Projects <span className="text-[var(--text-subtle)]">/</span>{" "}
            {projectId}
          </span>
        }
        title="Atlas Web"
      />

      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <section className="grid gap-px overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-4">
          {(
            [
              ["Primary metric", "1.82s", "p75 LCP · minimize"],
              ["Improvement", "−24.8%", "from 2.42s baseline"],
              ["Experiments", "42", "12 kept · 28.6%"],
              ["Knowledge", "9", "7 high confidence"],
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
              {[
                {
                  id: "run-042",
                  number: 7,
                  status: "running",
                  metric: "1.94s",
                  change: "−19.8%",
                  experiments: "4 / 12",
                  budget: "$4.82 / $12",
                  time: "38 min",
                },
                {
                  id: "run-038",
                  number: 6,
                  status: "completed",
                  metric: "2.03s",
                  change: "−16.1%",
                  experiments: "12 / 12",
                  budget: "$10.46 / $12",
                  time: "2h 14m",
                },
                {
                  id: "run-026",
                  number: 5,
                  status: "completed",
                  metric: "2.18s",
                  change: "−9.9%",
                  experiments: "10 / 10",
                  budget: "$8.31 / $10",
                  time: "1h 46m",
                },
              ].map((run) => (
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
                    tone={run.status === "running" ? "running" : "success"}
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
                {[
                  ["Source", "acme/atlas-web"],
                  ["Branch", "socrates/lcp"],
                  ["Metric", "Lighthouse p75 LCP"],
                  ["Direction", "Minimize"],
                  ["Min. change", "0.05s"],
                  ["Sample", "3 × Mobile"],
                ].map(([term, value]) => (
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
              <div className="mt-4 font-mono text-2xl">2.42s</div>
              <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                Recorded on commit 9e42a1c with protocol v3.
              </p>
              <Button className="mt-4 w-full" size="sm">
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
