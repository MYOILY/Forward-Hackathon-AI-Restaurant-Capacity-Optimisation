import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/web',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4175', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: [['list'], ['junit', { outputFile: 'test-results/browser.xml' }]],
  webServer: { command: 'npm run dev -- --port 4175 --strictPort', url: 'http://127.0.0.1:4175', reuseExistingServer: false, timeout: 30000 },
});
