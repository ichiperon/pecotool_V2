import { defineConfig, devices } from '@playwright/test';

const isCiLikeRun = !!process.env.CI || process.env.npm_lifecycle_event === 'test:e2e:ci';

/**
 * Tauri E2E Test Configuration
 * Playwright を使用して Tauri アプリケーションの WebView を直接テストします。
 */
export default defineConfig({
  testDir: './src/__tests__/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  retries: isCiLikeRun ? 1 : 0,
  fullyParallel: false, // Tauri は単一プロセスが基本なので並列化は避ける
  workers: 1,           // ポート競合を防ぐため
  reporter: 'html',
  
  use: {
    actionTimeout: 10 * 1000,
    trace: isCiLikeRun ? 'retain-on-failure' : 'on-first-retry',
    baseURL: 'http://localhost:1420',
  },

  projects: [
    {
      name: 'tauri-app',
      use: {
        ...devices['Desktop Chrome'],
        // Tauri アプリケーションの WebView (Chromium) をエミュレート
        viewport: { width: 1200, height: 800 },
      },
    },
  ],

  // Tauri Dev Server を立ち上げてからテストを実行する設定
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !isCiLikeRun,
    timeout: 180 * 1000, // 3分まで待つ
  },
});
