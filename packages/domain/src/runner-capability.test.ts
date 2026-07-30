import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { runnerSatisfiesCapabilities } from "./runner-capability";

const baseCapabilities = [
  {
    kind: "sandbox.oci" as const,
    platform: "linux" as const,
    architecture: "amd64" as const,
  },
  { kind: "action.command" as const, shell: false as const },
  { kind: "network.egress" as const, mode: "disabled" as const },
];

describe("runner capability matching", () => {
  it("matches closed capabilities independent of declaration order", () => {
    expect(
      runnerSatisfiesCapabilities(
        [...baseCapabilities].reverse(),
        baseCapabilities,
      ),
    ).toBe(true);
  });

  it("defaults to deny for unknown, duplicate, or incompatible capabilities", () => {
    expect(
      runnerSatisfiesCapabilities(
        [...baseCapabilities, { kind: "host.shell" }],
        baseCapabilities,
      ),
    ).toBe(false);
    expect(
      runnerSatisfiesCapabilities(
        [...baseCapabilities, baseCapabilities[0]],
        baseCapabilities,
      ),
    ).toBe(false);
    expect(
      runnerSatisfiesCapabilities(baseCapabilities, [
        ...baseCapabilities.slice(0, 2),
        { kind: "network.egress", mode: "allowlist" },
      ]),
    ).toBe(false);
  });

  it("requires accelerator capacity at or above the task requirement", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 64 }),
        (available, required) => {
          expect(
            runnerSatisfiesCapabilities(
              [
                ...baseCapabilities,
                {
                  kind: "accelerator.nvidia",
                  maximumDevices: available,
                },
              ],
              [
                ...baseCapabilities,
                {
                  kind: "accelerator.nvidia",
                  maximumDevices: required,
                },
              ],
            ),
          ).toBe(available >= required);
        },
      ),
    );
  });
});
