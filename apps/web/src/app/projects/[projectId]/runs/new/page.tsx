import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Panel } from "@socrates/design-system";

import { CreateRunForm } from "@/components/forms/create-run-form";
import { PageHeader } from "@/components/page-header";
import { ControlPlaneError } from "@/lib/api/client";
import { getProject } from "@/lib/api/queries";

type NewRunPageProps = {
  params: Promise<{ projectId: string }>;
};

export const dynamic = "force-dynamic";

async function loadProject(projectId: string) {
  try {
    return await getProject(projectId);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: NewRunPageProps): Promise<Metadata> {
  const { projectId } = await params;
  const project = await loadProject(projectId);
  return {
    title: `New run · ${project.name}`,
    description: `Create a bounded research run for ${project.name}.`,
  };
}

export default async function NewRunPage({ params }: NewRunPageProps) {
  const { projectId } = await params;
  const project = await loadProject(projectId);

  return (
    <>
      <PageHeader
        description="Set the immutable protocol snapshot and hard resource limits for this research session."
        eyebrow={`${project.name} / New run`}
        title="New run"
      />
      <div className="mx-auto max-w-3xl p-6 sm:p-8">
        <Panel className="p-5 sm:p-6">
          <CreateRunForm project={project} />
        </Panel>
      </div>
    </>
  );
}
