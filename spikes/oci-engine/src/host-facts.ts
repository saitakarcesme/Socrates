import { readFile } from "node:fs/promises";

import type { HostFacts } from "./types";

async function readsAs(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim().toLowerCase() === expected;
  } catch {
    return false;
  }
}

export async function readHostFacts(): Promise<HostFacts> {
  const [apparmor, selinux] = await Promise.all([
    readsAs("/sys/module/apparmor/parameters/enabled", "y"),
    readsAs("/sys/fs/selinux/enforce", "1"),
  ]);
  return {
    securityModules: [
      ...(apparmor ? (["apparmor"] as const) : []),
      ...(selinux ? (["selinux"] as const) : []),
    ],
  };
}
