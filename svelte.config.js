import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * 完全クライアント側処理・サーバールート無し（ADR-001/009）。
 * adapter-static の出力を Cloudflare Workers の静的アセットとして配信する（wrangler.toml の [assets]）。
 * 実質1ページのためプリレンダリングのみ（SPA fallback は付けない＝プリレンダHTMLが活きる）。
 * 将来クライアント専用の動的ルートを増やす場合は fallback か _redirects を再検討する。
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // CSP（ADR-004）。静的配信のためヘッダを持てないので hash モードで <meta> に出力する。
    // SvelteKit が自前の inline ブートストラップ script をハッシュ化して script-src に追加する。
    // WASM 実行に 'wasm-unsafe-eval'、Web Worker に worker-src、PDF/zip の blob URL を許可。外部接続なし。
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self", "wasm-unsafe-eval"],
        "worker-src": ["self", "blob:"],
        // Svelte/SvelteKit ランタイムが要素へ inline style 属性を設定するため許容（scriptは厳格なまま）。
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:", "blob:"],
        // pdfcpu.wasm のみ jsdelivr から版固定＋SHA-256検証で取得（25MiB制限回避, ADR-004）。
        "connect-src": ["self", "https://cdn.jsdelivr.net"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["none"],
      },
    },
  },
};

export default config;
