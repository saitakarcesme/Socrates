export type EventCursorAdvance = "duplicate" | "next" | "gap";

export function classifyEventSequence(
  current: number,
  incoming: number,
): EventCursorAdvance {
  if (incoming <= current) return "duplicate";
  if (incoming === current + 1) return "next";
  return "gap";
}
