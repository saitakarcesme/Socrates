import { Check } from "lucide-react";

import { Button, Panel, StatusBadge } from "@socrates/design-system";

import { PageHeader } from "@/components/page-header";

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 border-b border-[var(--border)] px-5 py-5 last:border-0 md:grid-cols-[minmax(220px,1fr)_minmax(260px,1fr)] md:items-start">
      <div>
        <h3 className="text-[13px] font-medium">{title}</h3>
        <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-muted)]">
          {description}
        </p>
      </div>
      <div>{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        description="Workspace defaults, limits, and execution connections."
        title="Settings"
      />

      <div className="mx-auto max-w-4xl p-6 sm:p-8">
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold">Workspace</h2>
          <Panel>
            <SettingRow
              description="Displayed across projects, runs, and shared artifacts."
              title="Workspace name"
            >
              <input
                className="h-8 w-full rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-xs outline-none focus:border-neutral-500"
                defaultValue="Personal workspace"
              />
            </SettingRow>
            <SettingRow
              description="Used for timestamps in the product and exported reports."
              title="Timezone"
            >
              <select className="h-8 w-full rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 text-xs outline-none">
                <option>Europe/Warsaw (UTC+02:00)</option>
                <option>UTC</option>
              </select>
            </SettingRow>
          </Panel>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold">Research defaults</h2>
          <Panel>
            <SettingRow
              description="Maximum amount Socrates can consume across active runs each day."
              title="Daily budget"
            >
              <div className="flex">
                <span className="flex h-8 items-center rounded-l-[4px] border border-r-0 border-[var(--border-strong)] bg-[var(--surface)] px-3 font-mono text-xs text-[var(--text-muted)]">
                  USD
                </span>
                <input
                  className="h-8 min-w-0 flex-1 rounded-r-[4px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 font-mono text-xs outline-none"
                  defaultValue="30.00"
                />
              </div>
            </SettingRow>
            <SettingRow
              description="Runs stop before executing an experiment that would exceed this limit."
              title="Experiments per run"
            >
              <input
                className="h-8 w-full rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 font-mono text-xs outline-none"
                defaultValue="12"
              />
            </SettingRow>
          </Panel>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold">Runners</h2>
          <Panel>
            <div className="flex items-center gap-4 p-5">
              <span className="flex size-8 items-center justify-center rounded-[4px] border border-emerald-900 bg-emerald-950/20 text-emerald-400">
                <Check className="size-4" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">local-01</span>
                  <StatusBadge tone="success">connected</StatusBadge>
                </div>
                <p className="mt-1 font-mono text-[10px] text-[var(--text-subtle)]">
                  local · darwin-arm64 · v0.1 protocol
                </p>
              </div>
              <Button className="ml-auto" size="sm">
                Configure
              </Button>
            </div>
          </Panel>
        </section>

        <div className="flex justify-end">
          <Button variant="primary">Save changes</Button>
        </div>
      </div>
    </>
  );
}
