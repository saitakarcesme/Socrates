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

export const projects = [
  {
    id: "atlas-web",
    name: "Atlas Web",
    objective: "Reduce p75 LCP without regressing conversion",
    metric: "LCP",
    best: "1.82s",
    change: "−24.8%",
    runs: 7,
    status: "running" as const,
    updated: "2 min ago",
  },
  {
    id: "meridian-eval",
    name: "Meridian Eval",
    objective: "Improve agent task completion on SWE-bench subset",
    metric: "Pass rate",
    best: "63.4%",
    change: "+8.1%",
    runs: 4,
    status: "paused" as const,
    updated: "3 hr ago",
  },
  {
    id: "northstar-data",
    name: "Northstar Data",
    objective: "Increase labeled dataset agreement above 95%",
    metric: "Agreement",
    best: "94.7%",
    change: "+3.2%",
    runs: 3,
    status: "completed" as const,
    updated: "Yesterday",
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
