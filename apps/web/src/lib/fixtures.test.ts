import { describe, expect, it } from "vitest";

import {
  getExperiment,
  getProject,
  getRun,
  getRunsForProject,
} from "./fixtures";

describe("fixture read boundary", () => {
  it("resolves projects and their runs", () => {
    expect(getProject("atlas-web")?.name).toBe("Atlas Web");
    expect(getRunsForProject("atlas-web")).toHaveLength(3);
  });

  it("rejects a run under the wrong project", () => {
    expect(getRun("meridian-eval", "run-042")).toBeUndefined();
  });

  it("rejects an experiment under the wrong run", () => {
    expect(getExperiment("atlas-web", "run-038", "exp-042")).toBeUndefined();
  });

  it("resolves a valid project, run, and experiment chain", () => {
    expect(getExperiment("atlas-web", "run-042", "exp-041")?.sequence).toBe(41);
  });
});
