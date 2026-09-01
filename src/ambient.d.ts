// PWA 情報仮想モジュール（@vite-pwa）。manifest link タグを提供する。
declare module "virtual:pwa-info" {
  export const pwaInfo: { webManifest: { href: string; linkTag: string } } | undefined;
}

// PWA の SW 登録仮想モジュール（@vite-pwa）。
declare module "virtual:pwa-register" {
  export function registerSW(options?: {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegisteredSW?: (swScriptUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }): (reloadPage?: boolean) => Promise<void>;
}

// Vite の ?url アセットインポートと、型を持たない WASM パッケージの最小宣言。
declare module "*.wasm?url" {
  const url: string;
  export default url;
}

// @jspawn/ghostscript-wasm は型定義を持たない Emscripten モジュールファクトリ。
declare module "@jspawn/ghostscript-wasm" {
  const createGs: (opts?: Record<string, unknown>) => Promise<any>;
  export default createGs;
}
// CJS 本体を直接 import する経路（Rollup 本番バンドル対策）。
declare module "@jspawn/ghostscript-wasm/gs.js" {
  const createGs: (opts?: Record<string, unknown>) => Promise<any>;
  export default createGs;
}
