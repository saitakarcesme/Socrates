import { describe, expect, it } from "vitest";

import { sandboxProfile } from "./profile";
import { evaluateFixedProfile } from "./engine-spike";

const commonHostConfig = {
  CapDrop: ["ALL"],
  Devices: [],
  IpcMode: "private",
  LogConfig: { Type: "none" },
  Memory: sandboxProfile.memoryBytes,
  MemorySwap: sandboxProfile.memoryBytes,
  NanoCpus: 500_000_000,
  NetworkMode: "none",
  PidsLimit: sandboxProfile.maximumPids,
  Privileged: false,
  ReadonlyRootfs: true,
  SecurityOpt: ["no-new-privileges:true"],
  ShmSize: sandboxProfile.sharedMemoryBytes,
  Tmpfs: {
    "/tmp": `rw,size=${sandboxProfile.temporaryBytes}`,
    "/workspace": `rw,size=${sandboxProfile.workspaceBytes}`,
  },
};

describe("engine inspection normalization", () => {
  it("accepts Docker-compatible private namespace fields", () => {
    expect(
      evaluateFixedProfile({
        HostConfig: {
          ...commonHostConfig,
          CgroupnsMode: "private",
          PidMode: "",
        },
      }),
    ).toMatchObject({ passed: true });
  });

  it("accepts Podman's native private namespace fields", () => {
    expect(
      evaluateFixedProfile({
        HostConfig: {
          ...commonHostConfig,
          CgroupMode: "private",
          PidMode: "private",
          SecurityOpt: ["no-new-privileges"],
          ShmSize: 0,
          Tmpfs: {
            ...commonHostConfig.Tmpfs,
            "/dev/shm": `rw,size=${sandboxProfile.sharedMemoryBytes}`,
          },
        },
      }),
    ).toMatchObject({ passed: true });
  });

  it("fails closed when a requested isolation field is absent", () => {
    const result = evaluateFixedProfile({
      HostConfig: {
        ...commonHostConfig,
        CgroupnsMode: "private",
        PidMode: "host",
      },
    });

    expect(result).toMatchObject({ passed: false });
    expect(result.detail).toContain("PID namespace");
  });
});
