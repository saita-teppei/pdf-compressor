# サードパーティ通知（Third-Party Notices）

- Date: 2026-09-01
- Related: ADR-003, COMPLIANCE.md（§4 依存ライセンス点検, §5）

本ファイルは、本サービスが利用する第三者ソフトウェアのライセンスと著作権表示を集約する。**依存構成が確定した時点で正式版を生成**する。現段階はテンプレートと確定済みの主要依存のみ。

## 記載フォーマット

各依存について以下を記録する。

| 依存 | バージョン | ライセンス | AGPL結合可否 | 通知/著作権表示 |
|---|---|---|---|---|

## ランタイム依存（アプリ本体に同梱・配信されるもの）

| 依存 | バージョン | ライセンス | AGPL結合可否 | 備考 |
|---|---|---|---|---|
| @jspawn/ghostscript-wasm | ^0.0.2 | AGPL-3.0 | 可（AGPL側を採用: ADR-003） | 圧縮エンジン（画像/スキャン）。gs.wasm 同梱 |
| pdfcpu-wasm | ^0.1.0 | Apache-2.0（ラッパーMIT） | 可 | 圧縮エンジン（構造最適化）＋ inspect。**pdfcpu.wasm(30MB) は Cloudflare の25MiB/ファイル上限のため同梱せず jsdelivr から版固定＋SHA-256検証で取得**（ADR-004）。JSラッパーは同梱 |
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

## 点検メモ

- Apache-2.0 / MIT / BSD / ISC は AGPLv3 と結合可（著作権表示・通知の保持が必要）。
- GPL-2.0 **only** は AGPLv3 と非互換のため採用しない。
- 各依存の**著作権表示・ライセンス全文**は、配信物または本ファイルに保持する。

> 生成手順（依存確定後）: パッケージマネージャのライセンス抽出ツール等で一覧を生成し、本テンプレートへ反映する。
