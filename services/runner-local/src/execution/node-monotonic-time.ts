import { performance } from "node:perf_hooks";

import type { MonotonicTimeSource } from "./timing-barrier";

export const nodeMonotonicTimeSource: MonotonicTimeSource = Object.freeze({
  now(): number {
    return performance.now();
  },
});
