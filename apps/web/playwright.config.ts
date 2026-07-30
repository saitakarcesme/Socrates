import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @socrates/api dev",
      cwd: "../..",
      url: "http://127.0.0.1:3001/v1/health",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @socrates/web dev",
      cwd: "../..",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
  ],
});
