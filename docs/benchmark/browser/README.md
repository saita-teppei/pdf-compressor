# 実ブラウザ計測ハーネス（PoC）

Node 計測ハーネス（`../harness/`）が Node 上でエンジンを実測するのに対し、こちらは
**実ブラウザ（Chromium）の Web Worker + Comlink** で同じエンジンを駆動し、
処理時間・初期ロード・メモリ・キャンセルを実測する。ADR-004/005/008 の
「ブラウザ実行経路」検証 PoC（結果は `../RESULTS.md` 第6回）。

本番アプリ（ADR-009: SvelteKit）ではないが、`src/engine-contract.ts` と
`src/*-browser-engine.ts` は本番エンジンアダプタの土台になる。

## 構成

- `src/engine-contract.ts` — ADR-008 の `CompressionEngine` 契約の最小 TS 版。
- `src/gs-browser-engine.ts` — Ghostscript。`../harness/gs-engine.mjs` の `toGsArgs` を移植（圧縮引数は Node 版と同一に保つ）。
- `src/pdfcpu-browser-engine.ts` — pdfcpu（第二候補）。
- `src/idb-cache.ts` — 16MB/30MB WASM の IndexedDB キャッシュ（ADR-004 §3）。
- `src/worker.ts` — Comlink で圧縮 API を公開。入力/出力は Transferable。
- `src/main.ts` — `window.__bench` を公開（Playwright から呼ぶ）。
- `tests/browser-bench.spec.ts` — コーパス×条件を計測し JSON 出力。desktop/mobile の2プロファイル。

## 実行

```bash
# 前提: コーパス生成済み（無ければ ../corpus/generate_corpus.py）
npm install && npx playwright install chromium

npx playwright test browser-bench.spec.ts --project=desktop   # -> browser-results.json（出力PDFを out/ に保存）
npx playwright test browser-bench.spec.ts --project=mobile    # -> browser-results-mobile.json（参考値）

# Node 実測との等価性・頁維持・SSIM（既存スクリプトを流用）
cd ../harness
python verify_pages.py ../browser/browser-results.json
python compute_ssim.py ../browser/browser-results.json
```

## ハマりどころ（このハーネス固有）

- **エンジンのロードは自前 fetch→事前 compile→毎回 instantiate**。GS は Emscripten の
  fetch/streaming 分岐を避けるため `instantiateWasm` フックで事前 compile した Module を渡す
  （Node 版が `WebAssembly.instantiate(bytes)` で回避したのと同じ発想のブラウザ版）。
- **WASM は `?url` でアセット参照**（`import gsWasmUrl from '@jspawn/ghostscript-wasm/gs.wasm?url'`）。
  `vite.config.ts` で `assetsInlineLimit:0` にして巨大バイナリのインライン化を防ぐ。
- **Emscripten パッケージは optimizeDeps から exclude**（CJS グルーの事前バンドル失敗を避ける）。
- **ピークメモリは `measureUserAgentSpecificMemory` が使えない**（COI 必須・ADR-004 で COI 不採用）。
  代わりに WASM 線形メモリ `buffer.byteLength` を代理値として採る。
- **mobile プロジェクトはデバイスエミュレーション + CDP CPU 4x スロットルの参考値**であり、
  実機の CPU/メモリは反映しない。処理時間の実機計測は別途必要。
- 生成物（`out/`, `browser-results*.json`, `node_modules/`, `dist/`）は `.gitignore` 済み。
