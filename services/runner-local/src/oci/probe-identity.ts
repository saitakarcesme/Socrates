import { randomUUID } from "node:crypto";

import { z } from "zod";

const sandboxProbeIdentitySchema = z
  .object({ taskId: z.uuid(), attemptId: z.uuid() })
  .strict();

export type SandboxProbeIdentity = Readonly<{
  taskId: string;
  attemptId: string;
}>;

export interface SandboxProbeIdentitySource {
  next(): SandboxProbeIdentity;
}

const nodeSandboxProbeIdentitySource = Object.freeze({
  next: () => Object.freeze({ taskId: randomUUID(), attemptId: randomUUID() }),
});

export function captureSandboxProbeIdentitySource(
  source: SandboxProbeIdentitySource = nodeSandboxProbeIdentitySource,
): SandboxProbeIdentitySource {
  let next: () => SandboxProbeIdentity;
  try {
    const candidate = source.next;
    if (typeof candidate !== "function") {
      throw new TypeError("Probe identity source is not callable.");
    }
    next = candidate.bind(source);
  } catch (cause) {
    throw new TypeError("Probe identity source is invalid.", { cause });
  }
  return Object.freeze({
    next: () => {
      const parsed = sandboxProbeIdentitySchema.safeParse(next());
      if (!parsed.success) {
        throw new TypeError(
          "Probe identity source returned an invalid value.",
          {
            cause: parsed.error,
          },
        );
      }
      return Object.freeze(parsed.data);
    },
  });
}
