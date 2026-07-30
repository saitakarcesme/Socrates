import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoots = ["apps", "packages", "services"];
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const forbiddenDependencies = new Set([
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "@huggingface/inference",
  "@socrates/orchestrator",
  "@socrates/runner-local",
  "langchain",
  "ollama",
]);
const forbiddenDependencyPrefixes = ["@ai-sdk/", "@langchain/", "@llamaindex/"];
const forbiddenRuntimeImports = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
];

async function filesBelow(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["dist", "node_modules", ".next", ".turbo"].includes(entry.name)) {
        files.push(...(await filesBelow(path, predicate)));
      }
    } else if (predicate(path)) {
      files.push(path);
    }
  }

  return files;
}

const violations = [];
for (const rootName of sourceRoots) {
  const root = join(workspaceRoot, rootName);
  const packageFiles = await filesBelow(root, (path) =>
    path.endsWith("package.json"),
  );

  for (const packageFile of packageFiles) {
    const manifest = JSON.parse(await readFile(packageFile, "utf8"));
    for (const section of dependencySections) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (
          forbiddenDependencies.has(dependency) ||
          forbiddenDependencyPrefixes.some((prefix) =>
            dependency.startsWith(prefix),
          )
        ) {
          violations.push(
            `${relative(workspaceRoot, packageFile)}: forbidden ${section} entry ${dependency}`,
          );
        }
      }
    }
  }

  const sourceFiles = await filesBelow(
    root,
    (path) =>
      path.split(/[\\/]/).includes("src") && /\.(?:[cm]?[jt]sx?)$/.test(path),
  );
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    if (
      relative(workspaceRoot, sourceFile).startsWith(
        join("apps", "web", "src"),
      ) &&
      /["']@socrates\/database(?:\/[^"']*)?["']/.test(source)
    ) {
      violations.push(
        `${relative(workspaceRoot, sourceFile)}: web source imports the database boundary`,
      );
    }
    for (const moduleName of forbiddenRuntimeImports) {
      const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const importPattern = new RegExp(
        `(?:from\\s*|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*)["']${escaped}["']`,
      );
      if (importPattern.test(source)) {
        violations.push(
          `${relative(workspaceRoot, sourceFile)}: forbidden runtime import ${moduleName}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Phase 1 dependency boundary violations:\n${violations.join("\n")}`,
  );
}

console.log(
  "Phase 1 dependency boundaries verified: no executor or model-provider dependencies.",
);
