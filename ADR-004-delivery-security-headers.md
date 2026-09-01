# ADR-004: 配信・セキュリティヘッダ・WASMキャッシュ・PWA方針

- Status: Accepted（COOP/COEP要否は調査で確定。PWAオフライン実装詳細は残）
- Date: 2026-09-01
- Related: ADR-001, ADR-002, ADR-003
- 調査結果: docs/research/wasm-threading-coi.md

## Context

ADR-001は完全クライアント側処理・Cloudflareでの静的配信を決めたが、以下の配信面の要件が未記載だった。

- WASMのスレッド実行（SharedArrayBuffer）に必要な **cross-origin isolation（COOP/COEP）**
- WASM実行を許可しつつ他を絞る **CSP**
- 巨大WASMバイナリの **キャッシュ／ロード戦略**
- **PWA / オフライン**対応の可否

悪性PDFに関しては、PDFを保存・送信しない設計上、情報漏洩（機密性）リスクは低い。残るのは可用性リスク（ハング・タブクラッシュ・破損出力）であり、それはタイムアウト・サイズ上限・出力検証で対処する（ADR-005/007）。本ADRは配信・ヘッダ・キャッシュに絞る。

## Decision（暫定）

### 1. Cross-Origin Isolation（調査で確定: 不要）

**調査結果（docs/research/wasm-threading-coi.md）**: 候補エンジンはブラウザで **single-thread 実行**であり `SharedArrayBuffer` を使わない。したがって **COOP/COEP（cross-origin isolation）は導入しない**。

- Ghostscript WASM（laurentmmeyer版・shubhamjha記事）は通常の Web Worker で実行し、`SharedArrayBuffer`/COOP/COEP を要求しない。
- pdfcpu（Go WASM）も js/wasm 上で single-thread であり同様に不要。
- UIブロッキング回避は **通常の Web Worker + Transferable/ArrayBuffer** で実現する（ADR-001通り。`SharedArrayBuffer` は使わない）。
- 将来 thread 版WASMを採用する場合のみ、Cloudflare Pages `_headers` で `COOP: same-origin` + `COEP: require-corp` を付与する（外部リソース制約が生じるため、その時点で再検討）。

### 2. CSP

- WASM実行に必要な最小限（`script-src 'self' 'wasm-unsafe-eval'` 等）を許可し、それ以外は自己オリジンに限定する。
- 外部への接続を持たない（PDFをサーバー送信しない設計を配信ポリシーでも担保する）。

### 3. WASMキャッシュ・ロード

- `WebAssembly.instantiateStreaming` でストリーミングコンパイル。
- Brotli/gzip圧縮配信、`Cache-Control` による長期キャッシュ＋**コンテンツハッシュ付きファイル名**でのバージョニング（キャッシュ破棄の制御）。
- WASMバイナリ（Ghostscriptで約16MB）は**初回のみ取得し以降はキャッシュ**する。shubhamjha記事では **IndexedDB キャッシュ**が実証済みで、これは isolation 非依存で機能する。
- 初回ロードNFR（ADR-005: デスクトップ≤5s / モバイル≤10s）を満たすことを計測で確認。

### 4. PWA / オフライン

- **PWA（インストール可能・アプリ的UX）は対応を目指す。**
- COOP/COEP を導入しない（§1）ため、isolation下のService Worker制約は回避でき、**オフライン実現のハードルは当初想定より低い**。
- WASMのキャッシュは **IndexedDB（実証済み）または Service Worker Cache** のいずれか。約16MBの容量・更新戦略（コンテンツハッシュでの更新）を設計する。
- それでも巨大WASMの更新・容量にハードルが残る場合は **オンライン限定**にフォールバックする。オフライン可否は実装フェーズで最終判断。

## 調査状況

| # | 項目 | 状況 |
|---|---|---|
| 1 | Ghostscript/pdfcpu WASMが single-thread か | **確定: single-thread**。COOP/COEP不要（wasm-threading-coi.md） |
| 2 | thread版が必要な場合の `_headers` isolation | 不要（将来採用時のみ）。Cloudflare Pagesで付与可能なことは確認済み |
| 3 | WASMのキャッシュ／オフライン起動 | IndexedDBキャッシュは実証済み。SW/IndexedDBのどちらでオフライン化するかは実装フェーズで判断 |

残: 採用WASMビルドで `SharedArrayBuffer` 参照が無いことの最終確認、モバイルでの16MBロード時間実測、オフライン方式の選定。

**実測反映（RESULTS.md 第6回 / 実ブラウザ PoC）**: `crossOriginIsolated=false`・`SharedArrayBuffer=undefined` を実機確認（COI 無しで動作、single-thread 前提が成立）。IndexedDB キャッシュは機能し、温取得 ~17–28ms・`WebAssembly.compile` 12–26ms と安価。**未確定**: 初回訪問時の 16MB/30MB の**実ネットワーク転送時間**（PoC は localhost 計測のため未反映）。実配信（Brotli/gzip）またはネットワークスロットル下での初回ロード NFR（≤5s/≤10s）再計測が残る。

## 実装反映（アプリ本体・M5）

- **CSP**: SvelteKit `kit.csp`（hash モード）で各HTMLの `<meta>` に出力（静的配信でヘッダを持てないため）。inline ブートストラップ script をビルド毎にハッシュ化。`script-src 'self' 'wasm-unsafe-eval' <hash>` / `worker-src 'self' blob:` / `connect-src 'self'`（外部接続なし）/ `style-src 'self' 'unsafe-inline'`（Svelteランタイム由来）/ `object-src 'none'` / `base-uri 'self'` / `form-action 'none'`。`static/_headers` に `frame-ancestors 'none'` 等のヘッダ専用項目と不変アセットの長期キャッシュを付与（meta の主CSPと非重複）。実ブラウザで違反0・圧縮動作を確認。
- **PWA**: `@vite-pwa/sveltekit`（Workbox）。**アプリシェル(JS/CSS/HTML)のみ precache**、16/30MB の WASM は precache せず既存の IndexedDB キャッシュでオフライン化。SW 登録はバンドル経由（`+layout.svelte`）で inline script を出さず CSP を厳格に維持。実機でインストール可・**オフライン再読込でアプリシェル表示**・CSP違反0を確認。
- **オフラインの制約（確定）**: 完全オフラインは「初回オンラインで WASM を取得後」に限る（初回オフラインは圧縮不可）。46MB precache は非現実的なため本方式を採用（ADR の「オフライン可否は実装時判断」に対する結論）。

## 配信の実測制約と対応（デプロイ, M5-3）

- **配信先**: Cloudflare **Workers（Static Assets）**。`adapter-static` の `build/` をアセットとして配信（SSR無し）。`wrangler.toml` の `[assets]`＋`wrangler deploy`。`_headers` も Workers Static Assets が適用（ライブで確認済み）。
- **1ファイル25 MiB上限にヒット**: `pdfcpu.wasm`(28.7 MiB) が Workers/Pages 共通の 25 MiB/ファイル上限で拒否された（実測）。`gs.wasm`(16MB) は範囲内。
- **対応（自己ホスト目標の一部緩和）**: `pdfcpu.wasm` **のみ** jsdelivr(npm ミラー) から**版固定**(`pdfcpu-wasm@0.1.0`)で取得し、`gs.wasm` は自己ホストのまま。**プライバシーの核心（PDF本体を送信しない）は不変**——取得するのは公開バイナリのみ。
  - **サプライチェーン対策**: 取得後に **SHA-256 検証**（`af8df1df…490054` をピン, `idb-cache.ts`）。不一致は失敗させる。取得済みは IndexedDB にキャッシュ（オフライン化も従来どおり）。
  - **CSP**: `connect-src` に `https://cdn.jsdelivr.net` のみ追加（他の外部接続は引き続き無し）。
  - Vite が pdfcpu-wasm 内部の `new URL(...wasm)` を静的解析で 30MB アセット化するため、ビルドから当該アセットを除去するプラグインを追加（`vite.config.ts`）。
- 公開URL例: `https://pdf-compressor.prkn.workers.dev`（Programing Study Society アカウント）。

## Consequences

- isolationを導入しないため、配信・埋め込みが単純化し、PWA/オフラインの難易度が下がる。
- 外部リソースをそもそも持たない自己ホスト構成とし、CSPと整合させる。
- 将来 thread 版WASM採用時のみ COOP/COEP と外部リソース制約が再浮上する。

## Revisit Conditions

- thread版WASM採用が必要になった時（COOP/COEP・外部リソース制約を再検討）
- オフライン方式（SW vs IndexedDB）確定時
