import { describe, expect, it } from "vitest";

import { parseEngineFacts, unavailableEngineFacts } from "./engine-adapter";

describe("OCI engine fact adapters", () => {
  it("classifies Docker Desktop evidence as non-native and non-rootless", () => {
    expect(
      parseEngineFacts(
        "docker",
        {
          Architecture: "x86_64",
          CgroupDriver: "cgroupfs",
          CgroupVersion: "2",
          Driver: "overlayfs",
          KernelVersion: "6.6.87.2-microsoft-standard-WSL2",
          OperatingSystem: "Docker Desktop",
          OSType: "linux",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
          ServerVersion: "29.3.1",
        },
        {
          Client: { Version: "29.3.1" },
          Server: { Version: "29.3.1" },
        },
      ),
    ).toMatchObject({
      engine: "docker",
      clientVersion: "29.3.1",
      cgroupVersion: "2",
      nativeLinux: false,
      rootless: false,
      desktopOrVm: true,
    });
  });

  it("normalizes a native rootless Podman host", () => {
    expect(
      parseEngineFacts(
        "podman",
        {
          host: {
            arch: "amd64",
            cgroupManager: "systemd",
            cgroupVersion: "v2",
            kernel: "6.8.0-57-generic",
            os: "linux",
            security: {
              apparmorEnabled: true,
              rootless: true,
              seccompEnabled: true,
              selinuxEnabled: false,
            },
          },
          store: { graphDriverName: "overlay" },
          version: { Version: "5.5.2" },
        },
        { Client: { Version: "5.5.2" } },
      ),
    ).toEqual({
      engine: "podman",
      available: true,
      clientVersion: "5.5.2",
      serverVersion: "5.5.2",
      operatingSystem: "linux",
      architecture: "amd64",
      kernelVersion: "6.8.0-57-generic",
      cgroupVersion: "2",
      cgroupDriver: "systemd",
      storageDriver: "overlay",
      securityOptions: ["name=seccomp", "name=apparmor", "name=rootless"],
      nativeLinux: true,
      rootless: true,
      desktopOrVm: false,
    });
  });

  it("uses nerdctl's documented Docker-compatible info mode", () => {
    expect(
      parseEngineFacts(
        "nerdctl",
        {
          Architecture: "amd64",
          CgroupDriver: "systemd",
          CgroupVersion: "2",
          Driver: "overlayfs",
          KernelVersion: "6.8.0",
          OperatingSystem: "Ubuntu 24.04",
          OSType: "linux",
          SecurityOptions: ["name=seccomp", "name=apparmor", "name=rootless"],
          ServerVersion: "2.1.4",
        },
        { Client: { Version: "2.1.4" } },
      ),
    ).toMatchObject({
      engine: "nerdctl",
      cgroupDriver: "systemd",
      nativeLinux: true,
      rootless: true,
      desktopOrVm: false,
    });
  });

  it("represents absence without inventing host facts", () => {
    expect(unavailableEngineFacts("podman")).toEqual({
      engine: "podman",
      available: false,
      securityOptions: [],
      nativeLinux: false,
      rootless: false,
      desktopOrVm: false,
    });
  });
});
