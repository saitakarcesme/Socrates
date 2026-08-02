import type { ProcessRequest } from "./process";

const exactEnvironmentNames = Object.freeze([
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "DOCKER_CONFIG",
  "NERDCTL_TOML",
] as const);

const forbiddenCommandFlags = Object.freeze([
  "--address",
  "--host",
  "-a",
  "-H",
  "--namespace",
  "-n",
  "--snapshotter",
  "--storage-driver",
  "--data-root",
  "--cgroup-manager",
  "--debug",
  "--debug-full",
  "--insecure-registry",
  "--experimental",
  "--kube-hide-dupe",
  "--selinux-enabled",
  "--userns-remap",
]);

export type NerdctlInvocationOptions = Readonly<{
  executable: string;
  address: string;
  namespace: string;
  snapshotter: "overlayfs" | "fuse-overlayfs" | "native";
  dataRoot: string;
  configurationPath: string;
  workingDirectory: string;
  environment: Readonly<{
    home: string;
    path: string;
    xdgConfigHome: string;
    xdgDataHome: string;
    xdgRuntimeDirectory: string;
    dockerConfigDirectory: string;
  }>;
}>;

export type NerdctlRequestBounds = Readonly<{
  timeoutMs: number;
  maximumOutputBytes: number;
  stdin?: Uint8Array;
  maximumInputBytes?: number;
  signal?: AbortSignal;
}>;

function fixedEnvironment(
  options: NerdctlInvocationOptions["environment"] & {
    configurationPath: string;
  },
) {
  const values = {
    HOME: options.home,
    PATH: options.path,
    XDG_CONFIG_HOME: options.xdgConfigHome,
    XDG_DATA_HOME: options.xdgDataHome,
    XDG_RUNTIME_DIR: options.xdgRuntimeDirectory,
    DOCKER_CONFIG: options.dockerConfigDirectory,
    NERDCTL_TOML: options.configurationPath,
  } satisfies Record<(typeof exactEnvironmentNames)[number], string>;
  const environment = Object.create(null) as Record<string, string>;
  for (const name of exactEnvironmentNames) {
    const value = values[name];
    if (value.length === 0 || value.includes("\0")) {
      throw new TypeError("Nerdctl environment is invalid.");
    }
    Object.defineProperty(environment, name, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(environment);
}

function forbidden(argument: string): boolean {
  return forbiddenCommandFlags.some(
    (flag) => argument === flag || argument.startsWith(`${flag}=`),
  );
}

export class NerdctlInvocation {
  readonly #executable: string;
  readonly #globalArguments: readonly string[];
  readonly #environment: Readonly<Record<string, string>>;
  readonly #workingDirectory: string;

  constructor(options: NerdctlInvocationOptions) {
    const executable = options.executable;
    const address = options.address;
    const namespace = options.namespace;
    const snapshotter = options.snapshotter;
    const dataRoot = options.dataRoot;
    const configurationPath = options.configurationPath;
    const workingDirectory = options.workingDirectory;
    const environment = options.environment;
    const environmentSnapshot = {
      home: environment.home,
      path: environment.path,
      xdgConfigHome: environment.xdgConfigHome,
      xdgDataHome: environment.xdgDataHome,
      xdgRuntimeDirectory: environment.xdgRuntimeDirectory,
      dockerConfigDirectory: environment.dockerConfigDirectory,
      configurationPath,
    };
    if (
      !executable.startsWith("/") ||
      executable.includes("\0") ||
      !address.startsWith("unix:///") ||
      namespace.length === 0 ||
      namespace.includes("\0") ||
      dataRoot.length === 0 ||
      dataRoot.includes("\0") ||
      !workingDirectory.startsWith("/") ||
      workingDirectory.includes("\0")
    ) {
      throw new TypeError("Nerdctl invocation policy is invalid.");
    }
    this.#executable = executable;
    this.#globalArguments = Object.freeze([
      `--address=${address}`,
      `--namespace=${namespace}`,
      `--snapshotter=${snapshotter}`,
      `--data-root=${dataRoot}`,
      "--cgroup-manager=systemd",
      "--debug=false",
      "--debug-full=false",
      "--insecure-registry=false",
      "--experimental=false",
      "--kube-hide-dupe=false",
      "--selinux-enabled=false",
      "--userns-remap=",
    ]);
    this.#environment = fixedEnvironment(environmentSnapshot);
    this.#workingDirectory = workingDirectory;
    Object.freeze(this);
  }

  request(
    commandArguments: readonly string[],
    bounds: NerdctlRequestBounds,
  ): ProcessRequest {
    if (
      !Array.isArray(commandArguments) ||
      commandArguments.length === 0 ||
      commandArguments[0]!.startsWith("-") ||
      commandArguments.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.includes("\0") ||
          forbidden(argument),
      )
    ) {
      throw new TypeError("Nerdctl command arguments are invalid.");
    }
    const sourceStdin = bounds.stdin;
    const stdin = sourceStdin ? Uint8Array.from(sourceStdin) : undefined;
    return Object.freeze({
      executable: this.#executable,
      arguments: Object.freeze([...this.#globalArguments, ...commandArguments]),
      environment: this.#environment,
      workingDirectory: this.#workingDirectory,
      timeoutMs: bounds.timeoutMs,
      maximumOutputBytes: bounds.maximumOutputBytes,
      stdin,
      maximumInputBytes: bounds.maximumInputBytes,
      signal: bounds.signal,
    });
  }
}
