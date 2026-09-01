import { defineConfig, devices } from "@playwright/test";

/**
 * 実ブラウザ計測用の Playwright 設定。
 * - webServer で Vite dev を起動（既に起動していれば再利用）。
 * - desktop（等身大）と mobile（デバイスエミュレーション + テスト内で CPU スロットル）の2プロジェクト。
 *   注意: エミュレーションは UA/ビューポート/タッチのみで実 CPU/メモリは変わらない。mobile の
 *   処理時間は CDP CPU スロットル(4x)で近似する参考値であり、実機計測の代替ではない（RESULTS で明記）。
 * - Chromium 前提（CPU スロットルと performance.memory は Chromium 依存）。
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60 * 1000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5175",
    trace: "off",
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium" } },
    { name: "mobile", use: { browserName: "chromium", ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5175",
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
});
