import { defineConfig, devices } from '@playwright/test';

// E2E テストは本番ビルド (vite preview) に対して実行する (Service Worker・CSP を含めて検証するため)
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'off',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    // Playwright 同梱の Chromium のみ (この開発環境に WebKit はない)。実機 Safari の検証は docs/testing.md を参照
    { name: 'android-chrome', use: { ...devices['Pixel 7'] } },
  ],
});
