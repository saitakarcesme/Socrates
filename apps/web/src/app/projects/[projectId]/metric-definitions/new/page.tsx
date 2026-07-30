import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Panel } from "@socrates/design-system";

import { ReviseMetricForm } from "@/components/forms/revise-metric-form";
import { PageHeader } from "@/components/page-header";
import { ControlPlaneError } from "@/lib/api/client";
import { getProject } from "@/lib/api/queries";

type ReviseMetricPageProps = {
  params: Promise<{ projectId: string }>;
};

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Revise metric protocol",
  description: "Create the next immutable metric protocol.",
};

async function loadProject(projectId: string) {
  try {
    return await getProject(projectId);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) notFound();
    throw error;
  }
}

export default async function ReviseMetricPage({
  params,
}: ReviseMetricPageProps) {
  const { projectId } = await params;
  const project = await loadProject(projectId);

  return (
    <>
      <PageHeader
        description="Create a complete immutable definition for subsequent runs. Existing runs retain their captured protocol."
        eyebrow={`${project.name} / Protocol v${project.currentMetric.version}`}
        title="Revise metric protocol"
      />
      <main className="mx-auto max-w-4xl p-6 sm:p-8">
        <Panel className="p-5 sm:p-7">
          <ReviseMetricForm project={project} />
        </Panel>
      </main>
    </>
  );
}
