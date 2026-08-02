import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  maximumNodeBoundedRegularFileBytes,
  NodeBoundedRegularFileReadError,
  type NodeBoundedRegularFileReadErrorCode,
} from "./bounded-regular-file-contracts";
import { NodeBoundedRegularFileReader } from "./bounded-regular-file-reader";

async function expectCode(
  operation: Promise<unknown>,
  code: NodeBoundedRegularFileReadErrorCode,
) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NodeBoundedRegularFileReadError);
  expect(error).toMatchObject({ code });
  expect(Object.isFrozen(error)).toBe(true);
  expect("cause" in (error as object)).toBe(false);
  return error as NodeBoundedRegularFileReadError;
}

function request(path = "/etc/socrates/input.json") {
  return {
    path,
    maximumBytes: 1_024,
    expectedOwnerUid: 1_000,
    mode: 0o444,
  };
}

describe("NodeBoundedRegularFileReader input admission", () => {
  it("is inert, frozen, and exposes only read", () => {
    const reader = new NodeBoundedRegularFileReader();
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Reflect.ownKeys(reader)).toEqual([]);
    expect(typeof reader.read).toBe("function");
  });

  it.each([
    null,
    [],
    Object.create(null),
    new Proxy(request(), {}),
    { ...request(), extra: true },
    { ...request(), path: "relative/file" },
    { ...request(), path: "/" },
    { ...request(), path: "/etc/socrates/" },
    { ...request(), path: "/etc//socrates/file" },
    { ...request(), path: "/etc/../file" },
    { ...request(), path: "/etc/./file" },
    { ...request(), path: "/etc/secret,file" },
    { ...request(), path: "/etc/secret\0file" },
    { ...request(), path: `/etc/${"e\u0301"}` },
    { ...request(), path: `/etc/${"x".repeat(4_097)}` },
    { ...request(), maximumBytes: 0 },
    { ...request(), maximumBytes: 1.5 },
    { ...request(), maximumBytes: maximumNodeBoundedRegularFileBytes + 1 },
    { ...request(), expectedOwnerUid: -1 },
    { ...request(), expectedOwnerUid: 4_294_967_295 },
    { ...request(), mode: 0 },
    { ...request(), mode: 0o644 },
    { ...request(), mode: 0o555 },
    { ...request(), mode: 0o1000 },
  ])("rejects malformed input before host access", async (candidate) => {
    await expectCode(
      new NodeBoundedRegularFileReader().read(candidate),
      "invalid_input",
    );
  });

  it("rejects accessors without invoking their values", async () => {
    let reads = 0;
    const candidate = {
      get path() {
        reads += 1;
        return "/private/secret";
      },
      maximumBytes: 16,
      expectedOwnerUid: 1_000,
      mode: 0o400,
    };

    await expectCode(
      new NodeBoundedRegularFileReader().read(candidate),
      "invalid_input",
    );
    expect(reads).toBe(0);
  });

  it("fails a valid request as unsupported on non-Linux before open", async () => {
    if (process.platform === "linux") return;
    await expectCode(
      new NodeBoundedRegularFileReader().read(request()),
      "unsupported_host",
    );
  });

  it("redacts proxy, path, and raw owner failures", async () => {
    const secretPath = "/private/secret-token-file";
    const proxied = new Proxy(request(secretPath), {
      ownKeys() {
        throw new Error("private proxy failure");
      },
    });
    const error = await expectCode(
      new NodeBoundedRegularFileReader().read(proxied),
      "invalid_input",
    );
    expect(error.message).not.toContain(secretPath);
    expect(error.stack).not.toContain(secretPath);
    expect(error.stack).not.toContain("private proxy failure");
    expect(JSON.stringify(error)).not.toContain(secretPath);
  });
});

describe.skipIf(process.platform !== "linux")(
  "NodeBoundedRegularFileReader Linux integration",
  () => {
    const roots: string[] = [];
    const fifoFixturePath = process.env["SOCRATES_TEST_FIFO"];

    async function root() {
      const path = await mkdtemp(join(tmpdir(), "socrates-reader-"));
      roots.push(path);
      return path;
    }

    function nativeRequest(path: string, maximumBytes = 1_024) {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("Linux UID is unavailable.");
      return { path, maximumBytes, expectedOwnerUid: uid, mode: 0o444 };
    }

    afterEach(async () => {
      await Promise.all(
        roots
          .splice(0)
          .map((path) => rm(path, { recursive: true, force: true })),
      );
    });

    it("reads exact bytes, proves EOF, closes, and detaches the result", async () => {
      const directory = await root();
      const path = join(directory, "configuration.json");
      await writeFile(path, new Uint8Array([1, 2, 3]), { mode: 0o444 });
      await chmod(path, 0o444);

      const input = nativeRequest(path, 3);
      const pending = new NodeBoundedRegularFileReader().read(input);
      input.path = join(directory, "missing-after-admission");
      input.maximumBytes = 1;
      input.expectedOwnerUid += 1;
      input.mode = 0o400;
      const output = await pending;
      expect(output).toEqual(new Uint8Array([1, 2, 3]));

      await chmod(path, 0o644);
      await writeFile(path, new Uint8Array([9, 9, 9]));
      expect(output).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("rejects empty and over-limit regular files", async () => {
      const directory = await root();
      const emptyPath = join(directory, "empty");
      const largePath = join(directory, "large");
      await writeFile(emptyPath, new Uint8Array(), { mode: 0o444 });
      await writeFile(largePath, new Uint8Array([1, 2, 3, 4]), {
        mode: 0o444,
      });
      await chmod(emptyPath, 0o444);
      await chmod(largePath, 0o444);

      await expectCode(
        new NodeBoundedRegularFileReader().read(nativeRequest(emptyPath)),
        "size_limit",
      );
      await expectCode(
        new NodeBoundedRegularFileReader().read(nativeRequest(largePath, 3)),
        "size_limit",
      );
    });

    it("rejects missing, symlink, directory, hard-link, owner, and mode drift", async () => {
      const directory = await root();
      const file = join(directory, "file");
      const symbolic = join(directory, "symbolic");
      const linked = join(directory, "linked");
      const childDirectory = join(directory, "directory");
      await writeFile(file, new Uint8Array([1]), { mode: 0o444 });
      await chmod(file, 0o444);
      await symlink(file, symbolic);
      await mkdir(childDirectory);

      const reader = new NodeBoundedRegularFileReader();
      await expectCode(
        reader.read(nativeRequest(join(directory, "missing"))),
        "open_failed",
      );
      await expectCode(reader.read(nativeRequest(symbolic)), "open_failed");
      await expectCode(
        reader.read(nativeRequest(childDirectory)),
        "invalid_metadata",
      );

      await link(file, linked);
      await expectCode(reader.read(nativeRequest(file)), "invalid_metadata");
      await rm(linked);

      const wrongOwner = nativeRequest(file);
      wrongOwner.expectedOwnerUid += 1;
      await expectCode(reader.read(wrongOwner), "invalid_metadata");
      await expectCode(
        reader.read({ ...nativeRequest(file), mode: 0o400 }),
        "invalid_metadata",
      );
    });

    it.skipIf(fifoFixturePath === undefined)(
      "opens a provisioned FIFO nonblocking and rejects it before reading",
      async () => {
        if (!fifoFixturePath) throw new Error("FIFO fixture is unavailable.");
        await expectCode(
          new NodeBoundedRegularFileReader().read(
            nativeRequest(fifoFixturePath),
          ),
          "invalid_metadata",
        );
      },
    );
  },
);
