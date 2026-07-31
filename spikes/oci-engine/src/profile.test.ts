import { describe, expect, it } from "vitest";

import { ownedContainerFilter, secureRunArguments } from "./profile";

describe("OCI spike sandbox profile", () => {
  it.each(["docker", "podman", "nerdctl"] as const)(
    "builds a fixed default-deny %s invocation",
    (engine) => {
      const args = secureRunArguments(
        engine,
        { name: "socrates-spike-test", spikeId: "test-id" },
        "example.invalid/image@sha256:abc",
        ["/bin/true"],
      );

      expect(args).toContain("none");
      expect(args).toContain("--ipc");
      expect(args).toContain("--cgroupns");
      expect(args).toContain("--pull");
      expect(args).toContain("never");
      expect(args).toContain("--log-driver");
      expect(args).toContain("none");
      expect(args).toContain("--read-only");
      expect(args).toContain("65534:65534");
      expect(args).toContain("ALL");
      expect(args).toContain("--pids-limit");
      expect(args).toContain("--memory");
      expect(args).toContain("--memory-swap");
      expect(args).toContain("--cpus");
      expect(args.join(" ")).not.toContain("--privileged");
      expect(args.join(" ")).not.toContain("/var/run/docker.sock");
      expect(args.at(-1)).toBe("/bin/true");
      expect(args.includes("--pid")).toBe(engine === "podman");
      expect(args.includes("--read-only-tmpfs=false")).toBe(
        engine === "podman",
      );
    },
  );

  it("scopes cleanup enumeration to both ownership labels", () => {
    expect(ownedContainerFilter("spike-1")).toEqual([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=socrates.managed=true",
      "--filter",
      "label=socrates.spike.id=spike-1",
    ]);
  });
});
