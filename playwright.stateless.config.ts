import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/stateless-browser",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:4176", browserName: "chromium",
    channel: process.env.STATELESS_BROWSER_CHANNEL,
    headless: true, viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  outputDir: "test-results/stateless-browser",
  webServer: [
    {
      command: ".venv/bin/python -m service.stateless_server --port 8001",
      url: "http://127.0.0.1:8001/frames/capabilities", timeout: 30000,
      env: { TABLEWATCH_ALLOWED_ORIGIN: "http://127.0.0.1:4176" },
      reuseExistingServer: process.env.STATELESS_REUSE_SERVER === "1",
    },
    {
      command: "npm run dev -- --port 4176 --strictPort",
      url: "http://127.0.0.1:4176", timeout: 30000,
      env: { VITE_PROCESSING_MODE: "stateless", VITE_STATELESS_API_URL: "http://127.0.0.1:8001" },
      reuseExistingServer: process.env.STATELESS_REUSE_SERVER === "1",
    },
  ],
});
