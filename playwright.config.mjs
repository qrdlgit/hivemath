import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  timeout: 45_000,
  workers: 1,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "PORT=4174 STORE_FILE=/tmp/mathhive-playwright.json RESET_STORE=1 node server/app.mjs",
    url: "http://127.0.0.1:4174/api/health",
    reuseExistingServer: false,
    timeout: 20_000
  }
});
