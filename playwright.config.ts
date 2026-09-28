import { defineConfig } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4174'
const registeredFlowOnly = process.env.PLAYWRIGHT_REGISTERED_FLOW === '1'

export default defineConfig({
  testDir: './e2e',
  testMatch: registeredFlowOnly ? '**/registered-flow.spec.ts' : '**/local-serving.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
})
