export const fixtureRunnerId = "10000000-0000-4000-8000-000000000001";
export const fixtureCredential = `srt1.90000000-0000-4000-8000-000000000009.${"a".repeat(43)}`;
export const fixtureImageDigest = `sha256:${"1".repeat(64)}`;

function portable(path: string): string {
  return path.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/");
}

export function fixtureApplicationConfiguration(parent = "/var/lib/socrates") {
  const privateRoot = portable(parent);
  return {
    version: "1",
    identity: {
      deploymentId: "runner-application-1",
      runnerId: fixtureRunnerId,
    },
    controlPlane: {
      origin: "https://control.socrates.test",
      timeoutMs: 10_000,
      maximumResponseBytes: 1_048_576,
    },
    roots: {
      artifacts: `${privateRoot}/artifacts`,
      sources: `${privateRoot}/sources`,
      journal: `${privateRoot}/journal`,
      spool: `${privateRoot}/spool`,
    },
    engine: {
      executable: "/usr/local/bin/nerdctl",
      address: "unix:///run/containerd/containerd.sock",
      snapshotter: "overlayfs",
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
      readinessTtlMs: 30_000,
      controlTimeoutMs: 12_345,
      executionTimeoutMs: 300_000,
      maximumControlOutputBytes: 234_567,
    },
    source: {
      maximumArchiveBytes: 2_097_152,
      maximumExpandedBytes: 8_388_608,
      maximumEntries: 1_000,
      maximumFileBytes: 2_097_152,
      maximumPathBytes: 4_096,
      maximumComponentBytes: 255,
      maximumPathDepth: 64,
    },
    request: { maximumBytes: 1_048_576 },
    runtime: {
      maximumProtocolBytes: 524_288,
      maximumChildOutputBytes: 2_097_152,
    },
    execution: {
      maximumWallTimeMs: 300_000,
      maximumMemoryBytes: 1_073_741_824,
      maximumPids: 128,
      maximumWritableBytes: 1_073_741_824,
      maximumRuntimeOutputBytes: 2_097_152,
      maximumCommandCount: 3,
      temporaryBytes: 67_108_864,
      sharedMemoryBytes: 67_108_864,
      cpuQuotaPeriodMicros: 100_000,
      minimumCpuQuotaMicros: 1_000,
      maximumCpuQuotaMicros: 100_000,
    },
    durability: {
      journal: {
        maximumManifestBytes: 10_000,
        maximumClaimBytes: 1_000_000,
        maximumItems: 100,
        maximumJournalBytes: 10_000_000,
      },
      spool: {
        maximumSegmentBytes: 1_000_000,
        maximumEventsPerSegment: 100,
        maximumAttempts: 100,
        maximumSpoolBytes: 10_000_000,
      },
    },
    lifecycle: {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      revocationGracePeriodMs: 0,
      maximumRecoveryAttempts: 1,
      pollIntervalMs: 25,
    },
  };
}

export function fixtureTrustedImages() {
  return {
    version: "1",
    images: [
      {
        digest: fixtureImageDigest,
        manifestMediaType: "application/vnd.oci.image.manifest.v1+json",
        configurationDigest: `sha256:${"2".repeat(64)}`,
        architecture: "amd64",
        runtimeBuildDigest: `sha256:${"3".repeat(64)}`,
        runtimeBundleDigest: `sha256:${"4".repeat(64)}`,
        runtime: {
          executable: "/usr/local/bin/node",
          arguments: ["/opt/socrates/task-runtime.mjs"],
        },
        profileProbe: { executable: "/bin/probe", arguments: [] },
        environment: ["PATH=/usr/local/bin:/usr/bin:/bin"],
      },
    ],
  };
}
