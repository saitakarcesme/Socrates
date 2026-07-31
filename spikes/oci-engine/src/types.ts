export const supportedEngines = ["docker", "podman", "nerdctl"] as const;
export type EngineName = (typeof supportedEngines)[number];

export type CommandResult = {
  command: string;
  args: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type GateResult = {
  name: string;
  passed: boolean;
  detail: string;
  durationMs?: number;
};

export type LatencySummary = {
  samples: number;
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
};

export type EngineFacts = {
  engine: EngineName;
  available: boolean;
  clientVersion?: string;
  serverVersion?: string;
  operatingSystem?: string;
  architecture?: string;
  kernelVersion?: string;
  cgroupVersion?: string;
  cgroupDriver?: string;
  storageDriver?: string;
  securityOptions: readonly string[];
  nativeLinux: boolean;
  rootless: boolean;
  desktopOrVm: boolean;
};

export type SpikeEvidence = {
  schemaVersion: "1";
  spikeId: string;
  recordedAt: string;
  image: string;
  profile: {
    memoryBytes: number;
    cpuCount: number;
    maximumPids: number;
    workspaceBytes: number;
    temporaryBytes: number;
    sharedMemoryBytes: number;
    network: "none";
    rootFilesystem: "read-only";
  };
  facts: EngineFacts;
  preflight: readonly GateResult[];
  adversarial: readonly GateResult[];
  cancellation: readonly GateResult[];
  cleanup: readonly GateResult[];
  latency?: {
    runAndRemove: LatencySummary;
  };
  eligibleForNativeSelection: boolean;
  limitations: readonly string[];
};
