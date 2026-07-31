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
const modelDependencies = new Set([
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
  "@huggingface/inference",
  "langchain",
  "ollama",
]);
const modelDependencyPrefixes = ["@ai-sdk/", "@langchain/", "@llamaindex/"];
const executionDependencies = new Set([
  "cross-spawn",
  "execa",
  "shelljs",
  "zx",
]);
const executionImports = [
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

function isExecutionPlane(path) {
  return path.startsWith(join("services", "runner-local"));
}

function isAuthorizedOciProcessBoundary(path, source) {
  return (
    path === join("services", "runner-local", "src", "oci", "process.ts") &&
    /import\s*\{\s*spawn\s*\}\s*from\s*["']node:child_process["']/.test(
      source,
    ) &&
    (source.match(/(?:node:)?child_process/g) ?? []).length === 1 &&
    !["worker_threads", "node:worker_threads"].some((moduleName) =>
      importsModule(source, moduleName),
    ) &&
    source.includes("shell: false") &&
    !/\b(?:exec|execFile|fork|spawnSync)\s*\(/.test(source)
  );
}

function importsModule(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:from\\s*|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*)["']${escaped}["']`,
  ).test(source);
}

export async function auditBoundaries(phase) {
  if (phase !== 1 && phase !== 2) {
    throw new Error(`Unsupported boundary audit phase: ${phase}`);
  }

  const violations = [];
  for (const rootName of sourceRoots) {
    const root = join(workspaceRoot, rootName);
    const packageFiles = await filesBelow(root, (path) =>
      path.endsWith("package.json"),
    );

    for (const packageFile of packageFiles) {
      const manifest = JSON.parse(await readFile(packageFile, "utf8"));
      const packagePath = relative(workspaceRoot, packageFile);
      for (const section of dependencySections) {
        for (const dependency of Object.keys(manifest[section] ?? {})) {
          if (
            modelDependencies.has(dependency) ||
            modelDependencyPrefixes.some((prefix) =>
              dependency.startsWith(prefix),
            )
          ) {
            violations.push(
              `${packagePath}: forbidden ${section} model dependency ${dependency}`,
            );
          }
          if (
            (phase === 1 || !isExecutionPlane(packagePath)) &&
            executionDependencies.has(dependency)
          ) {
            violations.push(
              `${packagePath}: forbidden ${section} execution dependency ${dependency}`,
            );
          }
          if (
            phase === 1 &&
            ["@socrates/orchestrator", "@socrates/runner-local"].includes(
              dependency,
            )
          ) {
            violations.push(
              `${packagePath}: forbidden ${section} Phase 1 dependency ${dependency}`,
            );
          }
          if (
            phase === 2 &&
            packagePath.startsWith("apps") &&
            dependency === "@socrates/runner-local"
          ) {
            violations.push(
              `${packagePath}: control-plane app depends on the local runner`,
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
      const sourcePath = relative(workspaceRoot, sourceFile);
      if (
        sourcePath.startsWith(join("apps", "web", "src")) &&
        /["']@socrates\/database(?:\/[^"']*)?["']/.test(source)
      ) {
        violations.push(
          `${sourcePath}: web source imports the database boundary`,
        );
      }
      if (phase === 2 && isExecutionPlane(sourcePath)) {
        if (
          executionImports.some((moduleName) =>
            importsModule(source, moduleName),
          ) &&
          !isAuthorizedOciProcessBoundary(sourcePath, source)
        ) {
          violations.push(
            `${sourcePath}: unauthorized execution-plane process boundary`,
          );
        }
        continue;
      }
      for (const moduleName of executionImports) {
        if (importsModule(source, moduleName)) {
          if (isAuthorizedOciProcessBoundary(sourcePath, source)) {
            continue;
          }
          violations.push(
            `${sourcePath}: forbidden runtime import ${moduleName}`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Phase ${phase} dependency boundary violations:\n${violations.join("\n")}`,
    );
  }

  console.log(
    `Phase ${phase} dependency boundaries verified: control-plane execution and model-provider dependencies are absent.`,
  );
}
