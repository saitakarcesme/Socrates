import type { Metadata } from "next";

import { Panel } from "@socrates/design-system";

import { CreateProjectForm } from "@/components/forms/create-project-form";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "New project",
  description: "Define a measurable optimization objective.",
};

export default function NewProjectPage() {
  return (
    <>
      <PageHeader
        description="Create the objective and immutable metric protocol that every experiment will measure."
        eyebrow="Projects / New"
        title="New project"
      />
      <div className="mx-auto max-w-3xl p-6 sm:p-8">
        <Panel className="p-5 sm:p-6">
          <CreateProjectForm />
        </Panel>
      </div>
    </>
  );
}
