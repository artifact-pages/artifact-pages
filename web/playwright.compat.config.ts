import { defineConfig } from '@playwright/test'

// Focused smoke used only by scripts/compat-gate.mjs. It is separate from the
// main suite (web/playwright.config.ts matches only local-serving.spec.ts).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/compat-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../.local/compat-gate/playwright-results',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    browserName: 'chromium',
    trace: 'off',
  },
})
