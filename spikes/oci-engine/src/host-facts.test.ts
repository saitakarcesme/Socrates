import { describe, expect, it } from "vitest";

import { readHostFacts } from "./host-facts";

describe("reference host facts", () => {
  it("returns only recognized security modules", async () => {
    const facts = await readHostFacts();

    expect(
      facts.securityModules.every(
        (module) => module === "apparmor" || module === "selinux",
      ),
    ).toBe(true);
  });
});
