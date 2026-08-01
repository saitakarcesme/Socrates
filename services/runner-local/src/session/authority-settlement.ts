import type { LeaseAuthorityResult } from "../supervision/lease-authority-monitor";

function sameTermination(
  left: Extract<LeaseAuthorityResult, { state: "cancelled" }>["termination"],
  right: Extract<LeaseAuthorityResult, { state: "cancelled" }>["termination"],
): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "terminated" && left.forced === right.forced))
  );
}

export function sameLeaseAuthorityResult(
  left: LeaseAuthorityResult,
  right: LeaseAuthorityResult,
): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "stopped" || left.state === "stale") return true;
  if (left.state === "abandoned") {
    return right.state === "abandoned" && left.reason === right.reason;
  }
  if (left.state === "released") {
    return right.state === "released" && left.reason === right.reason;
  }
  if (right.state !== "cancelled") return false;
  const a = left.cancellation;
  const b = right.cancellation;
  return (
    a.version === b.version &&
    a.runnerId === b.runnerId &&
    a.taskId === b.taskId &&
    a.attemptId === b.attemptId &&
    a.fence === b.fence &&
    a.requestedAt === b.requestedAt &&
    a.gracePeriodMs === b.gracePeriodMs &&
    a.reason === b.reason &&
    sameTermination(left.termination, right.termination)
  );
}
