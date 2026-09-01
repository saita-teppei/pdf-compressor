# サードパーティ通知（Third-Party Notices）

- Date: 2026-09-02
- Related: ADR-003, COMPLIANCE.md（§4 依存ライセンス点検, §5）

本ファイルは、本サービスが利用する第三者ソフトウェアのライセンスと著作権表示を集約する。MVP の依存構成は確定済みで、下表は 2026-09-02 時点の `package.json` / `package-lock.json` と一致する。未了項目は末尾の注記を参照。

## 記載フォーマット

各依存について以下を記録する。

| 依存 | バージョン | ライセンス | AGPL結合可否 | 通知/著作権表示 |
|---|---|---|---|---|

## ランタイム依存（アプリ本体に同梱・配信されるもの）

| 依存 | バージョン | ライセンス | AGPL結合可否 | 備考 |
|---|---|---|---|---|
| @jspawn/ghostscript-wasm | 0.0.2 | AGPL-3.0 | 可（AGPL側を採用: ADR-003） | 圧縮エンジン（画像/スキャン）。gs.wasm を同梱・自己ホスト配信。**本パッケージが AGPL-3.0 であることが、アプリ全体を AGPL-3.0 とする直接の理由**（§下記の著作権表示）|
| pdfcpu-wasm（npmラッパー） | 0.1.0 | MIT | 可 | JSラッパー。同梱 LICENSE は MIT（`Copyright (c) 2025 jsscheller`）。ラッパーJSのみ同梱 |
| pdfcpu（`pdfcpu.wasm` の中身） | pdfcpu-wasm 0.1.0 に対応 | Apache-2.0（上流） | 可 | 構造最適化＋inspect の実体。**pdfcpu.wasm(30MB) は Cloudflare の25MiB/ファイル上限のため同梱せず jsdelivr から版固定＋SHA-256検証で取得**（ADR-004）|
| svelte / @sveltejs/kit / adapter-static | ^5 / ^2 / ^3 | MIT | 可 | UI・ビルド・静的配信（ADR-009） |
| @sveltejs/vite-plugin-svelte / vite | ^4 / ^5 | MIT | 可 | ビルド |
| comlink | ^4.4.2 | Apache-2.0 | 可 | メイン↔Worker RPC（ADR-009） |
| fflate | ^0.8.2 | MIT | 可 | ZIP 一括ダウンロード（M3） |
| @inlang/paraglide-js | ^2.25 | MIT | 可 | i18n（ja/en）。コンパイル時にメッセージを生成（ADR-009） |

### ビルド/開発のみ（配信物に同梱しない）

| 依存 | ライセンス | 備考 |
|---|---|---|
| @inlang/plugin-message-format | Apache-2.0 | inlang メッセージ書式プラグイン。ビルド時に CDN から読み込む（生成専用） |
| svelte-check / typescript | MIT / Apache-2.0 | 型チェック |
| @types/node | MIT | vite.config.ts の Node API（child_process / process.env）の型。配信物には含まれない |
| （ベンチ）@playwright/test, axe-core | Apache-2.0 / MPL-2.0 | 実ブラウザ計測・a11y 監査（docs/benchmark, dev専用） |
| （コーパス生成）reportlab, pillow, img2pdf | BSD / HPND / LGPL-3.0 | 合成コーパス生成（dev専用, アプリ非同梱） |

> 注: `@jspawn/ghostscript-wasm` が AGPL-3.0 のため、アプリ全体が AGPL-3.0（ADR-003）。上記はいずれも AGPLv3 と結合可能。

## 著作権表示・必要な通知文（COMPLIANCE.md §3/§5）

配信物に結合される第三者ソフトウェアの著作権表示を保持する。ライセンス全文は各パッケージ同梱の
`LICENSE`（`node_modules/<pkg>/LICENSE`）と、本リポジトリ直下の `LICENSE`（AGPLv3全文）による。

### Ghostscript（`@jspawn/ghostscript-wasm` の `gs.wasm`）

```
Ghostscript
Copyright (C) Artifex Software, Inc.
Licensed under the GNU Affero General Public License version 3.
```

同梱の `node_modules/@jspawn/ghostscript-wasm/LICENSE` は AGPLv3 の全文（著作権行を持たない標準テキスト）。
本アプリはリポジトリ直下 `LICENSE` に同一の全文を保持し、アプリ内フッターからソースと稼働コミットへ導線を張る
（AGPLv3 §13, `src/routes/+layout.svelte`）。

### pdfcpu-wasm（JSラッパー）

```
MIT License
Copyright (c) 2025 jsscheller
https://github.com/jsscheller/pdfcpu-wasm
```

### pdfcpu（`pdfcpu.wasm` の中身）

```
pdfcpu — Apache License 2.0
https://github.com/pdfcpu/pdfcpu
```

> **未了**: npm パッケージ `pdfcpu-wasm` はラッパーの MIT LICENSE のみを同梱し、pdfcpu 上流の
> Apache-2.0 ライセンス全文と `NOTICE` を含んでいない。Apache-2.0 §4 はこれらの保持を求めるため、
> 上流リポジトリから全文・NOTICE・著作権行を取得して本ファイルへ転記する必要がある。
> 上記の Apache-2.0 表記は上流リポジトリの記載に基づくもので、同梱ファイルによる裏取りは未実施。

## 点検メモ

- Apache-2.0 / MIT / BSD / ISC は AGPLv3 と結合可（著作権表示・通知の保持が必要）。
- GPL-2.0 **only** は AGPLv3 と非互換のため採用しない。
- 各依存の**著作権表示・ライセンス全文**は、配信物または本ファイルに保持する。

> 更新手順: 依存を追加・更新したら、`node_modules/<pkg>/package.json` の `license` と同梱 `LICENSE` を確認し、本ファイルの表と「著作権表示・必要な通知文」節へ反映する（COMPLIANCE.md §4/§5）。npm メタデータの `license` はラッパーのものを指す場合があるため、同梱 LICENSE の実物を必ず見る（`pdfcpu-wasm` が実例）。
