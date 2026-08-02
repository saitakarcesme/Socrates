import { NerdctlInvocation } from "./invocation";

export function nativeReferenceNerdctlInvocation(options: {
  deploymentId: string;
  home: string;
  runtimeDirectory: string;
}): NerdctlInvocation {
  return new NerdctlInvocation({
    executable: "/usr/local/bin/nerdctl",
    address: "unix:///run/containerd/containerd.sock",
    namespace: `socrates-${options.deploymentId}`,
    snapshotter: "overlayfs",
    dataRoot: `${options.home}/.local/share/nerdctl`,
    configurationPath: "/etc/socrates/runner-local/nerdctl.toml",
    workingDirectory: `${options.home}/.local/state/socrates/runner`,
    environment: {
      home: options.home,
      path: "/usr/local/bin:/usr/bin:/bin",
      xdgConfigHome: `${options.home}/.config/socrates`,
      xdgDataHome: `${options.home}/.local/share`,
      xdgRuntimeDirectory: options.runtimeDirectory,
      dockerConfigDirectory: `${options.home}/.config/socrates/docker`,
    },
  });
}
