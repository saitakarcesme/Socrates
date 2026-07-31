import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const serviceRoot = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(serviceRoot, "dist/task-runtime.mjs");
const manifestPath = resolve(serviceRoot, "dist/build-identity.json");
const digestPlaceholder = `sha256:${"0".repeat(64)}`;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function bundle(buildDigest) {
  const result = await build({
    absWorkingDir: serviceRoot,
    banner: { js: "#!/usr/bin/env node" },
    bundle: true,
    define: {
      __SOCRATES_RUNTIME_BUILD_DIGEST__: JSON.stringify(buildDigest),
    },
    entryPoints: ["src/cli.ts"],
    format: "esm",
    legalComments: "none",
    minify: false,
    outfile: outputPath,
    platform: "node",
    target: "node22",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Runtime bundle produced no output.");
  return output.contents;
}

const placeholderBundle = await bundle(digestPlaceholder);
const runtimeBuildDigest = sha256(placeholderBundle);
const finalBundle = await bundle(runtimeBuildDigest);
const bundleDigest = sha256(finalBundle);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, finalBundle, { mode: 0o755 });
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schema: "socrates.task-runtime.build.v1",
      abi: "socrates.task-runtime.v1",
      runtimeBuildDigest,
      bundleDigest,
      entrypoint: {
        executable: "/usr/local/bin/node",
        arguments: ["/opt/socrates/task-runtime.mjs"],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
