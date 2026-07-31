import {
  encodeRuntimeMessage,
  runtimeAbi,
  runtimeFrameSchema,
  type RuntimeFrame,
} from "@socrates/runtime-protocol";
import { describe, expect, it } from "vitest";

import { issueInspectedSandboxImage } from "./capability";
import {
  NerdctlImageHandshakeVerifier,
  type InspectedImageExecutor,
} from "./handshake";
import { fixtureIdentity, fixtureProfile } from "../oci/test-fixtures";

import type {
  SandboxExecutionResult,
  SandboxImageProbeExecution,
} from "../oci/backend";

const manifestDigest = `sha256:${"a".repeat(64)}`;
const buildDigest = `sha256:${"b".repeat(64)}`;
const image = issueInspectedSandboxImage({
  reference: manifestDigest,
  localName: "docker.io/socrates/runtime:admitted",
  digest: manifestDigest,
  configurationDigest: `sha256:${"b".repeat(64)}`,
  architecture: "amd64",
  profileProbe: { executable: "/bin/probe", arguments: [] },
});
const runtime = {
  executable: "/usr/local/bin/node",
  arguments: ["/opt/socrates/task-runtime.mjs", "--handshake"],
} as const;

function framed(...frames: RuntimeFrame[]): Uint8Array {
  const encoded = frames.map((frame) =>
    encodeRuntimeMessage(runtimeFrameSchema, frame, 16 * 1_024),
  );
  const output = new Uint8Array(
    encoded.reduce((total, entry) => total + entry.byteLength, 0),
  );
  let offset = 0;
  for (const entry of encoded) {
    output.set(entry, offset);
    offset += entry.byteLength;
  }
  return output;
}

class FakeBackend implements InspectedImageExecutor {
  calls: SandboxImageProbeExecution[] = [];

  constructor(readonly result: SandboxExecutionResult) {}

  async executeInspectedImage(input: SandboxImageProbeExecution) {
    this.calls.push(input);
    return this.result;
  }
}

function result(
  stdoutBytes: Uint8Array,
  overrides: Partial<SandboxExecutionResult> = {},
): SandboxExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutBytes,
    stderrBytes: new Uint8Array(),
    durationMs: 1,
    ...overrides,
  };
}

describe("nerdctl image handshake verifier", () => {
  it("runs the inspected capability under the guarded backend and parses one frame", async () => {
    const backend = new FakeBackend(
      result(
        framed({
          type: "runtime.handshake",
          abi: runtimeAbi,
          buildDigest,
        }),
      ),
    );
    const verifier = new NerdctlImageHandshakeVerifier(backend, {
      runnerId: fixtureIdentity.runnerId,
      profile: fixtureProfile,
    });

    await expect(verifier.verify({ image, runtime })).resolves.toEqual({
      abi: runtimeAbi,
      buildDigest,
    });
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toMatchObject({
      image,
      profile: fixtureProfile,
      command: runtime,
    });
    expect(backend.calls[0]?.identity.runnerId).toBe(fixtureIdentity.runnerId);
  });

  it.each([
    [
      "extra frame",
      result(
        framed(
          { type: "runtime.handshake", abi: runtimeAbi, buildDigest },
          { type: "runtime.completed", status: "failed" },
        ),
      ),
    ],
    [
      "stderr",
      result(
        framed({ type: "runtime.handshake", abi: runtimeAbi, buildDigest }),
        { stderr: "noise", stderrBytes: Buffer.from("noise") },
      ),
    ],
    [
      "non-zero exit",
      result(
        framed({ type: "runtime.handshake", abi: runtimeAbi, buildDigest }),
        { exitCode: 2 },
      ),
    ],
    ["invalid UTF-8", result(Uint8Array.from([0, 0, 0, 2, 0xc3, 0x28]))],
  ])("rejects %s", async (_name, outcome) => {
    const verifier = new NerdctlImageHandshakeVerifier(
      new FakeBackend(outcome),
      { runnerId: fixtureIdentity.runnerId, profile: fixtureProfile },
    );
    await expect(verifier.verify({ image, runtime })).rejects.toThrow();
  });
});
