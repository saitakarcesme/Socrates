import { cache } from "react";

import { createServerControlPlaneClient } from "./server";

export const getProjects = cache(async () => {
  const response = await createServerControlPlaneClient().listProjects();
  return response.data;
});

export const getProject = cache(async (projectId: string) => {
  const response = await createServerControlPlaneClient().getProject(projectId);
  return response.data;
});

export const getRuns = cache(async (projectId: string) => {
  const response = await createServerControlPlaneClient().listRuns(projectId);
  return response.data;
});

export const getRun = cache(async (runId: string) => {
  const response = await createServerControlPlaneClient().getRun(runId);
  return response.data;
});

export const getExperiments = cache(async (runId: string) => {
  const response =
    await createServerControlPlaneClient().listExperiments(runId);
  return response.data;
});

export const getExperiment = cache(async (experimentId: string) => {
  const response =
    await createServerControlPlaneClient().getExperiment(experimentId);
  return response.data;
});

export const getLearnings = cache(async (projectId: string) => {
  const response =
    await createServerControlPlaneClient().listLearnings(projectId);
  return response.data;
});

export const getWorkspaceLearnings = cache(async () => {
  const response =
    await createServerControlPlaneClient().listWorkspaceLearnings();
  return response.data;
});
