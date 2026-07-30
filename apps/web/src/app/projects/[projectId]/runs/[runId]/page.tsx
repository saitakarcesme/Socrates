import { MoreHorizontal, Pause, Square } from "lucide-react";

import { Button, Metric, Panel, StatusBadge } from "@socrates/design-system";

import { ExperimentTimeline } from "@/components/experiment-timeline";
import { PageHeader } from "@/components/page-header";
import { experiments } from "@/lib/fixtures";

export default async function RunPage({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}) {
  const { projectId, runId } = await params;
  const runHref = `/projects/${projectId}/runs/${runId}`;

  return (
    <>
      <PageHeader
        actions={
          <div className="flex gap-2">
            <Button aria-label="More run actions">
              <MoreHorizontal className="size-3.5" />
            </Button>
            <Button>
              <Pause className="size-3.5" />
              Pause
            </Button>
            <Button variant="danger">
              <Square className="size-3" />
              Stop
            </Button>
          </div>
        }
        description="Improve p75 LCP through controlled changes to the critical rendering path."
        eyebrow={
          <span className="flex items-center gap-2">
            Atlas Web <span className="text-[var(--text-subtle)]">/</span> Run 7
            <StatusBadge tone="running">running</StatusBadge>
          </span>
        }
        title="Rendering path optimization"
      />

      <div className="mx-auto grid max-w-[1560px] xl:grid-cols-[minmax(0,1fr)_304px]">
        <section className="min-w-0 p-6 sm:p-8 xl:border-r xl:border-[var(--border)]">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h2 className="text-sm font-semibold">Experiment timeline</h2>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                4 of 12 experiments · newest first
              </p>
            </div>
            <button className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
              Filter
            </button>
          </div>
          <ExperimentTimeline items={experiments} runHref={runHref} />
        </section>

        <aside className="space-y-0 xl:sticky xl:top-0 xl:h-screen xl:overflow-y-auto">
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric detail="p75 LCP" label="Current metric" value="1.94s" />
            </div>
            <div className="p-4">
              <Metric
                detail="−24.8% overall"
                label="Best result"
                value="1.82s"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 border-b border-[var(--border)]">
            <div className="border-r border-[var(--border)] p-4">
              <Metric detail="of 2h 00m" label="Elapsed time" value="38:24" />
            </div>
            <div className="p-4">
              <Metric detail="of $12.00" label="Budget" value="$4.82" />
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Budget usage</h3>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                40%
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-[2px] bg-neutral-900">
              <div className="h-full w-[40%] bg-neutral-400" />
            </div>
            <div className="mt-3 flex justify-between font-mono text-[10px] text-[var(--text-subtle)]">
              <span>4 / 12 experiments</span>
              <span>$7.18 remaining</span>
            </div>
          </div>

          <div className="border-b border-[var(--border)] p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-medium">Knowledge</h3>
              <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                3 items
              </span>
            </div>
            <div className="space-y-3">
              {[
                "Critical CSS is currently the highest-confidence optimization surface.",
                "Analytics bootstrap delays the main thread on mid-tier mobile devices.",
                "Reducing image quality alone produces no meaningful LCP change.",
              ].map((knowledge, index) => (
                <div className="flex gap-2.5" key={knowledge}>
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-neutral-500" />
                  <p className="text-[11px] leading-[17px] text-[var(--text-muted)]">
                    {knowledge}
                  </p>
                  <span className="ml-auto font-mono text-[9px] text-[var(--text-subtle)]">
                    0.{9 - index}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <Panel className="m-4 p-3">
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-blue-400" />
              <span className="text-[11px] font-medium">Runner local-01</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[9px] text-[var(--text-subtle)]">
              <span>CPU 38%</span>
              <span>MEM 1.8 GB</span>
              <span>Node 22.17</span>
              <span>Lease 28s</span>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
