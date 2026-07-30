import { expect, test } from "@playwright/test";

test("completes a measured project-to-learning journey", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const uniqueName = `Journey ${Date.now()}`;
  await page.goto("/projects/new");

  await page.getByLabel("Name", { exact: true }).fill(uniqueName);
  await page
    .getByLabel("Objective")
    .fill("Reduce request latency through measured experiments.");
  await page
    .getByLabel("Source reference")
    .fill("https://example.com/acceptance");
  await page.getByLabel("Metric name").fill("p95 latency");
  await page.getByLabel("Unit", { exact: true }).fill("ms");
  await page.getByLabel("Minimum improvement").fill("5");
  await page.getByLabel("Noise tolerance").fill("1");

  await page.getByRole("button", { name: "Add guardrail" }).click();
  await page.getByLabel("Name", { exact: true }).nth(1).fill("Error rate");
  await page.getByLabel("Unit", { exact: true }).nth(1).fill("%");
  await page.getByLabel("Threshold").fill("1");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: uniqueName })).toBeVisible();

  await page.getByRole("link", { name: "New run" }).click();
  await page.getByLabel("Title").fill("Acceptance run");
  await page.getByLabel("Cost (minor units)").fill("100");
  await page.getByRole("button", { name: "Create draft run" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/runs/new"));
  const runUrl = page.url();

  await page.getByLabel("Metric value (ms)").fill("120");
  await page.getByLabel("Samples").fill("3");
  await page.getByRole("button", { name: "Record baseline" }).click();
  await page.getByRole("button", { name: "Start run" }).click();

  await page.getByRole("button", { name: "Propose experiment" }).click();
  await page
    .getByLabel("Hypothesis")
    .fill("Caching request normalization will reduce p95 latency.");
  await page
    .getByLabel("Planned action")
    .fill("Cache normalized context for the duration of one request.");
  await page.getByLabel("Estimated cost (minor units)").fill("10");
  await page.getByRole("button", { name: "Create proposal" }).click();

  await page.getByRole("button", { name: "Start experiment" }).click();
  await page.getByLabel("Value (ms)").fill("120");
  await page.getByLabel("Samples").fill("3");
  await page.getByRole("button", { name: "Record before" }).click();

  const afterPanel = page
    .getByRole("heading", { name: "Record metric after" })
    .locator("..");
  await afterPanel.getByLabel("Value (ms)").fill("110");
  await afterPanel.getByLabel("Samples").fill("3");
  await afterPanel.getByRole("button", { name: "Record after" }).click();
  await expect(
    page.getByRole("heading", { name: "Record metric after" }),
  ).toHaveCount(0);

  const guardrailPanel = page
    .getByRole("heading", { name: "Record guardrail · Error rate" })
    .locator("..");
  await guardrailPanel.getByLabel("Value (%)").fill("0.5");
  await guardrailPanel
    .getByRole("button", { name: "Record guardrail" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Record guardrail · Error rate" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Decide experiment" }).click();
  await expect(page.getByText("kept", { exact: true }).first()).toBeVisible();

  const learning =
    "Request-scoped normalization caching reduced p95 latency by 10 ms.";
  await page.getByLabel("Statement").fill(learning);
  await page.getByLabel("Confidence").fill("0.9");
  await page.getByRole("button", { name: "Save learning" }).click();
  await expect(page.getByText(learning, { exact: true })).toBeVisible();

  await page.goto(runUrl);
  await expect(page.getByText(learning, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Complete" }).click();
  await page.getByRole("button", { name: "Confirm complete" }).click();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});
