import { defineConfig } from "vite";

// 実ブラウザ計測ハーネス用の最小 Vite 設定。
// - WASM(16MB/30MB) は ?url でアセット参照する。assetsInlineLimit を明示的に小さくして
//   巨大バイナリが data: URL にインライン化されないことを保証する。
// - Emscripten(gs.js) は CJS グルーのため optimizeDeps の事前バンドルから除外し、
//   ブラウザ側で素直にロードさせる（prebundle 由来の失敗を避ける）。
export default defineConfig({
  build: { assetsInlineLimit: 0, target: "es2022" },
  optimizeDeps: { exclude: ["@jspawn/ghostscript-wasm", "pdfcpu-wasm"] },
  worker: { format: "es" },
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
});
