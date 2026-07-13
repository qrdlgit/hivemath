import { test, expect } from "@playwright/test";

async function join(page, name, pin) {
  await page.goto("/join/spectral-gap");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("PIN or small password").fill(pin);
  await page.getByRole("button", { name: "Join workspace" }).click();
  await expect(page.locator("#joinGate")).toBeHidden();
}

async function createSpace(page, name) {
  const payload = await page.evaluate(async (spaceName) => {
    const token = sessionStorage.getItem("mathhive.token");
    return fetch("/api/spaces", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: spaceName, rootTitle: "Visual root", rootStatement: "x=x" }) }).then((response) => response.json());
  }, name);
  await page.goto(`/join/${payload.space.inviteSlug}`);
  await expect(page.locator("#workspaceTitle")).toHaveText(name);
}

test("desktop graph remains framed and usable", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await join(page, "Desktop Audit", "9090");
  await expect(page.locator(".result-node").first()).toBeVisible();
  expect(await page.locator(".app-shell").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
  await expect(page.locator("#rightPanel")).toBeVisible();
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
  await page.screenshot({ path: testInfo.outputPath("mathhive-desktop.png"), fullPage: true });
  await createSpace(page, "Desktop Visual Program");
  await expect(page.getByRole("button", { name: "Copy context" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export .md" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-status-context-actions-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit" }).click();
  const statusBounds = await page.locator("#currentStatusModal > form").boundingBox();
  expect(statusBounds.x).toBeGreaterThanOrEqual(0);
  expect(statusBounds.width).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: testInfo.outputPath("current-status-desktop.png"), fullPage: true });
  await context.close();
});

test("mobile graph and authoring panel fit without horizontal overflow", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await context.newPage();
  await join(page, "Mobile Audit", "8080");
  await createSpace(page, "Mobile Visual Program");
  await expect(page.locator("#graphViewport")).toBeVisible();
  await page.getByRole("button", { name: "Notifications" }).click();
  await page.locator('[data-right-tab="work"]').click();
  await expect(page.getByRole("button", { name: "Copy context" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export .md" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-status-context-actions-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit" }).click();
  const statusBounds = await page.locator("#currentStatusModal > form").boundingBox();
  expect(statusBounds.x).toBeGreaterThanOrEqual(0);
  expect(statusBounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("current-status-mobile.png"), fullPage: true });
  const fillStatus = page.locator("#currentStatusModal").getByRole("button", { name: "Fill with Codex" });
  await fillStatus.scrollIntoViewIfNeeded();
  await expect(fillStatus).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-status-mobile-actions.png"), fullPage: true });
  await page.getByRole("button", { name: "Close current status" }).click();
  await page.getByRole("button", { name: "New result" }).click();
  await expect(page.locator("#resultEditor")).toBeVisible();
  const bounds = await page.locator("#resultEditor").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
  await page.screenshot({ path: testInfo.outputPath("mathhive-mobile.png"), fullPage: true });
  await context.close();
});
