import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageRoot = new URL("./", import.meta.url);
const outputDirectory = new URL("./dist/", packageRoot);

await rm(outputDirectory, { force: true, recursive: true });

await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("./src/server.ts", packageRoot))],
  format: "esm",
  logLevel: "info",
  outfile: fileURLToPath(new URL("./server.js", outputDirectory)),
  platform: "node",
  sourcemap: true,
  target: "node22",
});
