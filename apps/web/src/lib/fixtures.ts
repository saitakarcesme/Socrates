export type ExperimentFixture = {
  id: string;
  sequence: number;
  hypothesis: string;
  action: string;
  before: string;
  after: string | null;
  delta: string | null;
  decision: "kept" | "discarded" | "running";
  learnedKnowledge: string;
  duration: string;
  time: string;
};

export type ProjectFixture = {
  id: string;
  name: string;
  objective: string;
  description: string;
  metric: string;
  best: string;
  change: string;
  runs: number;
  status: "running" | "paused" | "completed";
  updated: string;
  baseline: string;
  experimentCount: string;
  learningCount: string;
  protocol: ReadonlyArray<readonly [string, string]>;
};

export type RunFixture = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: "running" | "paused" | "completed";
  metric: string;
  change: string;
  experiments: string;
  budget: string;
  time: string;
  experimentIds: readonly string[];
};

export const projects: readonly ProjectFixture[] = [
  {
    id: "atlas-web",
    name: "Atlas Web",
    objective: "Reduce p75 LCP without regressing conversion",
    description:
      "Reduce p75 Largest Contentful Paint without regressing conversion.",
    metric: "LCP",
    best: "1.82s",
    change: "−24.8%",
    runs: 7,
    status: "running",
    updated: "2 min ago",
    baseline: "2.42s",
    experimentCount: "42",
    learningCount: "9",
    protocol: [
      ["Source", "acme/atlas-web"],
      ["Branch", "socrates/lcp"],
      ["Metric", "Lighthouse p75 LCP"],
      ["Direction", "Minimize"],
      ["Min. change", "0.05s"],
      ["Sample", "3 × Mobile"],
    ],
  },
  {
    id: "meridian-eval",
    name: "Meridian Eval",
    objective: "Improve agent task completion on SWE-bench subset",
    description:
      "Increase task completion while holding token cost and latency within fixed guardrails.",
    metric: "Pass rate",
    best: "63.4%",
    change: "+8.1%",
    runs: 4,
    status: "paused",
    updated: "3 hr ago",
    baseline: "55.3%",
    experimentCount: "23",
    learningCount: "11",
    protocol: [
      ["Source", "acme/meridian-agent"],
      ["Branch", "socrates/swe-eval"],
      ["Metric", "Task completion"],
      ["Direction", "Maximize"],
      ["Min. change", "2.0 pp"],
      ["Sample", "120 tasks"],
    ],
  },
  {
    id: "northstar-data",
    name: "Northstar Data",
    objective: "Increase labeled dataset agreement above 95%",
    description:
      "Improve annotation agreement while preserving coverage across intent classes.",
    metric: "Agreement",
    best: "94.7%",
    change: "+3.2%",
    runs: 3,
    status: "completed",
    updated: "Yesterday",
    baseline: "91.5%",
    experimentCount: "18",
    learningCount: "7",
    protocol: [
      ["Source", "northstar/intent-v4"],
      ["Branch", "dataset revision 12"],
      ["Metric", "Krippendorff α"],
      ["Direction", "Maximize"],
      ["Min. change", "0.5 pp"],
      ["Sample", "600 labels"],
    ],
  },
];

export const runs: readonly RunFixture[] = [
  {
    id: "run-042",
    projectId: "atlas-web",
    number: 7,
    title: "Rendering path optimization",
    description:
      "Improve p75 LCP through controlled changes to the critical rendering path.",
    status: "running",
    metric: "1.94s",
    change: "−19.8%",
    experiments: "4 / 12",
    budget: "$4.82 / $12",
    time: "38 min",
    experimentIds: ["exp-042", "exp-041", "exp-040", "exp-039"],
  },
  {
    id: "run-038",
    projectId: "atlas-web",
    number: 6,
    title: "Main-thread contention",
    description:
      "Reduce scripting cost during the first interaction window without losing analytics events.",
    status: "completed",
    metric: "2.03s",
    change: "−16.1%",
    experiments: "12 / 12",
    budget: "$10.46 / $12",
    time: "2h 14m",
    experimentIds: [],
  },
  {
    id: "run-026",
    projectId: "atlas-web",
    number: 5,
    title: "Asset delivery baseline",
    description:
      "Establish the highest-impact asset and delivery optimizations for the product page.",
    status: "completed",
    metric: "2.18s",
    change: "−9.9%",
    experiments: "10 / 10",
    budget: "$8.31 / $10",
    time: "1h 46m",
    experimentIds: [],
  },
  {
    id: "run-023",
    projectId: "meridian-eval",
    number: 4,
    title: "Reasoning budget calibration",
    description:
      "Find the smallest reasoning budget that preserves completion quality.",
    status: "paused",
    metric: "63.4%",
    change: "+8.1%",
    experiments: "7 / 10",
    budget: "$16.20 / $25",
    time: "3h 08m",
    experimentIds: [],
  },
  {
    id: "run-018",
    projectId: "northstar-data",
    number: 3,
    title: "Temporal intent guidelines",
    description:
      "Reduce annotation ambiguity for requests with implicit time horizons.",
    status: "completed",
    metric: "94.7%",
    change: "+3.2%",
    experiments: "8 / 8",
    budget: "$6.14 / $8",
    time: "1h 22m",
    experimentIds: [],
  },
];

export const experiments: ExperimentFixture[] = [
  {
    id: "exp-042",
    sequence: 42,
    hypothesis:
      "Preloading the hero image will reduce LCP by removing resource discovery delay.",
    action:
      "Added fetchpriority=high and an explicit preload for the responsive hero source.",
    before: "1.94s",
    after: null,
    delta: null,
    decision: "running",
    learnedKnowledge: "Awaiting a complete three-run sample.",
    duration: "02:18",
    time: "Now",
  },
  {
    id: "exp-041",
    sequence: 41,
    hypothesis:
      "Inlining critical product-shell CSS will shorten the render-blocking path.",
    action:
      "Extracted 3.8 KB of above-the-fold CSS and deferred the remaining stylesheet.",
    before: "2.03s",
    after: "1.94s",
    delta: "−4.4%",
    decision: "kept",
    learnedKnowledge:
      "The product shell was stylesheet-bound; a small critical subset is sufficient for first paint.",
    duration: "06:42",
    time: "11 min ago",
  },
  {
    id: "exp-040",
    sequence: 40,
    hypothesis:
      "Serving the hero at lower JPEG quality will reduce transfer time enough to improve LCP.",
    action:
      "Reduced hero quality from 82 to 68 and regenerated source variants.",
    before: "2.03s",
    after: "2.01s",
    delta: "−1.0%",
    decision: "discarded",
    learnedKnowledge:
      "Image bytes are not the current bottleneck; discovery and render blocking dominate.",
    duration: "05:54",
    time: "28 min ago",
  },
  {
    id: "exp-039",
    sequence: 39,
    hypothesis:
      "Removing the analytics bootstrap from the critical path will reduce main-thread contention.",
    action:
      "Moved analytics initialization to requestIdleCallback with a 2s timeout.",
    before: "2.18s",
    after: "2.03s",
    delta: "−6.9%",
    decision: "kept",
    learnedKnowledge:
      "Analytics bootstrap contributes measurable main-thread delay on mid-tier mobile hardware.",
    duration: "07:11",
    time: "46 min ago",
  },
];

export const learnings = [
  {
    title: "Resource discovery is the remaining LCP bottleneck",
    summary:
      "After critical CSS extraction, the hero request begins too late in the navigation waterfall.",
    confidence: "High",
    evidence: "Experiments 40–42",
    project: "Atlas Web",
    updated: "2 min ago",
  },
  {
    title: "Analytics can leave the critical path safely",
    summary:
      "Idle initialization improved LCP without changing event delivery in the validation sample.",
    confidence: "High",
    evidence: "Experiment 39",
    project: "Atlas Web",
    updated: "46 min ago",
  },
  {
    title: "Longer reflection does not improve patch quality",
    summary:
      "Three reasoning passes performed within noise of one pass while increasing cost by 31%.",
    confidence: "Medium",
    evidence: "Experiments 17–23",
    project: "Meridian Eval",
    updated: "3 hr ago",
  },
  {
    title: "Label ambiguity clusters around temporal intent",
    summary:
      "Most annotator disagreement occurs when user intent depends on an unstated time horizon.",
    confidence: "Medium",
    evidence: "Runs 2–3",
    project: "Northstar Data",
    updated: "Yesterday",
  },
];

export function getProject(projectId: string): ProjectFixture | undefined {
  return projects.find((project) => project.id === projectId);
}

export function getRunsForProject(projectId: string): readonly RunFixture[] {
  return runs.filter((run) => run.projectId === projectId);
}

export function getRun(
  projectId: string,
  runId: string,
): RunFixture | undefined {
  return runs.find((run) => run.projectId === projectId && run.id === runId);
}

export function getExperimentsForRun(
  projectId: string,
  runId: string,
): readonly ExperimentFixture[] {
  const run = getRun(projectId, runId);

  if (!run) {
    return [];
  }

  const experimentIds = new Set(run.experimentIds);
  return experiments.filter((experiment) => experimentIds.has(experiment.id));
}

export function getExperiment(
  projectId: string,
  runId: string,
  experimentId: string,
): ExperimentFixture | undefined {
  return getExperimentsForRun(projectId, runId).find(
    (experiment) => experiment.id === experimentId,
  );
}
