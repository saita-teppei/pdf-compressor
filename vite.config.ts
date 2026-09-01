import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import { defineConfig, type Plugin } from "vite";

// pdfcpu-wasm ライブラリ内部の `new URL("pdfcpu.wasm", import.meta.url)` を Vite が静的解析して
// 30MB アセットを出力してしまう（実行時は p.wasm 注入で通らない死コード）。この巨大アセットを
// 最終バンドルから除去する（本体は jsdelivr から取得, ADR-004）。参照文字列は死コードなので無害。
const dropPdfcpuWasm = (): Plugin => ({
  name: "drop-pdfcpu-wasm-asset",
  generateBundle(_opts, bundle) {
    for (const key of Object.keys(bundle)) {
      if (/pdfcpu-[^/]*\.wasm$/.test(key)) delete bundle[key];
    }
  },
});

export default defineConfig({
  plugins: [
    dropPdfcpuWasm(),
    // i18n（ADR-009）。完全クライアント静的配信のため localStorage/ブラウザ言語で判定する。
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    sveltekit(),
    // PWA（ADR-004）。アプリシェル(JS/CSS/HTML)のみ precache。16/30MB の WASM は precache せず
    // 既存の IndexedDB キャッシュ(idb-cache.ts)でオフライン化する。SW 登録はバンドル経由（+layout.svelte）
    // で行い、inline script を出さず CSP を厳格に保つ（injectRegister: false）。
    SvelteKitPWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "PDF圧縮",
        short_name: "PDF圧縮",
        description: "ブラウザ内で完結するPDF圧縮。ファイルはサーバーへ送信しません。",
        lang: "ja",
        theme_color: "#2563eb",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        globIgnores: ["**/*.wasm"], // 巨大 WASM は SW precache しない（IndexedDB 側で扱う）
        navigateFallback: "/",
      },
      devOptions: { enabled: false },
    }),
  ],
  // 重い処理は Web Worker（ES module）で実行する（ADR-008）。
  worker: { format: "es", plugins: () => [dropPdfcpuWasm()] },
  // Emscripten(gs.js) の CJS グルーは dev の事前バンドルで問題が出やすいので除外する。
  optimizeDeps: { exclude: ["@jspawn/ghostscript-wasm", "pdfcpu-wasm"] },
});
