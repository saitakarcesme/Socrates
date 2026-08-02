import { describe, expect, it } from "vitest";

import { NerdctlInvocation } from "./invocation";
import type { NerdctlInvocationOptions } from "./invocation";

function options() {
  return {
    executable: "/usr/local/bin/nerdctl",
    address: "unix:///run/containerd/containerd.sock",
    namespace: "socrates-runner-prod-1",
    snapshotter: "overlayfs" as const,
    dataRoot: "/home/socrates/.local/share/socrates/nerdctl",
    configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
    workingDirectory: "/home/socrates/.local/state/socrates/runner",
    environment: {
      home: "/home/socrates",
      path: "/usr/local/bin:/usr/bin:/bin",
      xdgConfigHome: "/home/socrates/.config/socrates",
      xdgDataHome: "/home/socrates/.local/share/socrates",
      xdgRuntimeDirectory: "/run/user/1001",
      dockerConfigDirectory: "/home/socrates/.config/socrates/docker",
    },
  };
}

describe("nerdctl invocation authority", () => {
  it("builds one exact frozen global prefix and host environment", () => {
    const invocation = new NerdctlInvocation(options());
    const request = invocation.request(["info", "--format", "{{json .}}"], {
      timeoutMs: 12_345,
      maximumOutputBytes: 234_567,
    });

    expect(request).toEqual({
      executable: "/usr/local/bin/nerdctl",
      arguments: [
        "--address=unix:///run/containerd/containerd.sock",
        "--namespace=socrates-runner-prod-1",
        "--snapshotter=overlayfs",
        "--data-root=/home/socrates/.local/share/socrates/nerdctl",
        "--cgroup-manager=systemd",
        "--debug=false",
        "--debug-full=false",
        "--insecure-registry=false",
        "--experimental=false",
        "--kube-hide-dupe=false",
        "--selinux-enabled=false",
        "--userns-remap=",
        "info",
        "--format",
        "{{json .}}",
      ],
      environment: {
        HOME: "/home/socrates",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        XDG_CONFIG_HOME: "/home/socrates/.config/socrates",
        XDG_DATA_HOME: "/home/socrates/.local/share/socrates",
        XDG_RUNTIME_DIR: "/run/user/1001",
        DOCKER_CONFIG: "/home/socrates/.config/socrates/docker",
        NERDCTL_TOML: "/etc/socrates/runner-local/nerdctl.toml",
      },
      workingDirectory: "/home/socrates/.local/state/socrates/runner",
      timeoutMs: 12_345,
      maximumOutputBytes: 234_567,
      stdin: undefined,
      maximumInputBytes: undefined,
      signal: undefined,
    });
    expect(Object.getPrototypeOf(request.environment)).toBeNull();
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.arguments)).toBe(true);
    expect(Object.isFrozen(request.environment)).toBe(true);
    expect(request.environment).not.toHaveProperty("HTTP_PROXY");
    expect(request.environment).not.toHaveProperty("NODE_OPTIONS");
  });

  it("detaches constructor values and returns fresh immutable requests", () => {
    const candidate = options();
    const invocation = new NerdctlInvocation(candidate);
    candidate.executable = "/tmp/nerdctl";
    candidate.workingDirectory = "/tmp/working";
    candidate.environment.home = "/tmp/home";

    const first = invocation.request(["version"], {
      timeoutMs: 1,
      maximumOutputBytes: 1,
    });
    const second = invocation.request(["version"], {
      timeoutMs: 1,
      maximumOutputBytes: 1,
    });

    expect(first).not.toBe(second);
    expect(first.arguments).not.toBe(second.arguments);
    expect(first.executable).toBe("/usr/local/bin/nerdctl");
    expect(first.environment.HOME).toBe("/home/socrates");
    expect(first.workingDirectory).toBe(
      "/home/socrates/.local/state/socrates/runner",
    );
  });

  it("reads every constructor authority exactly once", () => {
    const source = options();
    const reads: string[] = [];
    const environment = Object.create(null) as Record<string, unknown>;
    for (const name of Object.keys(source.environment) as Array<
      keyof typeof source.environment
    >) {
      Object.defineProperty(environment, name, {
        enumerable: true,
        get: () => {
          reads.push(`environment.${name}`);
          return source.environment[name];
        },
      });
    }
    const candidate = Object.create(null) as Record<string, unknown>;
    for (const name of [
      "executable",
      "address",
      "namespace",
      "snapshotter",
      "dataRoot",
      "configurationPath",
      "workingDirectory",
    ] as const) {
      Object.defineProperty(candidate, name, {
        enumerable: true,
        get: () => {
          reads.push(name);
          return source[name];
        },
      });
    }
    Object.defineProperty(candidate, "environment", {
      enumerable: true,
      get: () => {
        reads.push("environment");
        return environment;
      },
    });

    new NerdctlInvocation(candidate as unknown as NerdctlInvocationOptions);

    expect(reads).toEqual([
      "executable",
      "address",
      "namespace",
      "snapshotter",
      "dataRoot",
      "configurationPath",
      "workingDirectory",
      "environment",
      "environment.home",
      "environment.path",
      "environment.xdgConfigHome",
      "environment.xdgDataHome",
      "environment.xdgRuntimeDirectory",
      "environment.dockerConfigDirectory",
    ]);
  });

  it.each([
    [],
    ["--help"],
    ["info", "--namespace=redirected"],
    ["info", "--address", "unix:///tmp/redirect.sock"],
    ["inspect", "-n", "redirected"],
    ["info\0unsafe"],
  ])("rejects command-level engine redirection %j", (command) => {
    expect(() =>
      new NerdctlInvocation(options()).request(command, {
        timeoutMs: 1,
        maximumOutputBytes: 1,
      }),
    ).toThrow("Nerdctl command arguments are invalid.");
  });

  it("copies bounded stdin before returning the request", () => {
    const stdin = Uint8Array.from([1, 2, 3]);
    const request = new NerdctlInvocation(options()).request(["create"], {
      timeoutMs: 1,
      maximumOutputBytes: 1,
      stdin,
      maximumInputBytes: 3,
    });
    stdin[0] = 9;
    expect(request.stdin).toEqual(Uint8Array.from([1, 2, 3]));
  });
});
