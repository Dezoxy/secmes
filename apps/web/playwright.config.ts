import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev --host localhost --port 5173 --strictPort',
    url: `${baseURL}/chat`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_DEMO_MODE: '1',
      VITE_E2E_GROUP_CREATE: '1',
      VITE_E2E_FRIENDS_UNAVAILABLE: '1',
      VITE_OIDC_ISSUER: '',
      VITE_OIDC_CLIENT_ID: '',
      VITE_OIDC_REDIRECT_URI: '',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
