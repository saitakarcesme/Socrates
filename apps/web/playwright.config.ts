import { defineConfig, devices } from "@playwright/test";

const apiPort = process.env["SOCRATES_E2E_API_PORT"] ?? "3101";
const webPort = process.env["SOCRATES_E2E_WEB_PORT"] ?? "3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
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
      env: {
        DATABASE_URL: process.env["DATABASE_URL"] ?? "",
        MANUAL_RESEARCH_ENABLED: "true",
        PORT: apiPort,
      },
      url: `http://127.0.0.1:${apiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @socrates/web exec next dev --port ${webPort}`,
      cwd: "../..",
      env: {
        SOCRATES_API_URL: `http://127.0.0.1:${apiPort}`,
      },
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
