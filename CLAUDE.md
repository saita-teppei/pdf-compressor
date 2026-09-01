# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの性質

ブラウザ（クライアント側）で動作するPDF圧縮サービスのリポジトリ。**設計・意思決定＋実測検証＋アプリ本体（MVP実装済み）**。成果物は次の3種:

1. **ADR群と仕様文書**（リポジトリ直下＋`docs/`）— 設計上の決定はここが唯一の正。
2. **ベンチマークハーネス** — (a) `docs/benchmark/harness/`（Node でエンジン候補を実測）、(b) `docs/benchmark/browser/`（実ブラウザ Web Worker+Comlink で同エンジンを実測する PoC。ADR-004/005/008 のブラウザ経路検証、RESULTS 第6回）。
3. **アプリ本体**（リポジトリルートの SvelteKit + `adapter-static`, ADR-009）— MVP実装済み（M0〜M5、`README.md` 参照）。`npm run dev|build|check|preview`。主コード: `src/lib/`（engines / worker / routing）、`src/routes/`、`messages/`（i18n）、`static/_headers`（CSP等）。

作業前にまず `GAP-ANALYSIS.md`（意思決定バックログの索引）と関連ADRを読むこと。ドキュメントは日本語。回答・コメントも日本語で。

## アーキテクチャの要点（複数ファイルにまたがる文脈）

- **完全クライアント側処理**（ADR-001）: PDF本体はサーバーへ送らない。Cloudflare Workers（Static Assets）は静的配信のみ（`adapter-static`, ADR-009）。
- **COOP/COEP不要**（ADR-004, `docs/research/wasm-threading-coi.md`）: 候補エンジンはブラウザで single-thread 実行、`SharedArrayBuffer` 不使用。重い処理は通常の Web Worker + Transferable。
- **エンジンは差し替え可能な抽象の背後**（`CompressionEngine`: initialize/inspect/compress/dispose, ADR-008）。第一候補 Ghostscript WASM（画像/スキャンに強い）、第二候補 pdfcpu（構造最適化・テキストに強い、画像は縮小しない）。
- **コンテンツ別ルーティング**（ADR-010, 実証済み）: `inspect` で種別判定 → 種別ごとに最適エンジン/設定 → **ガード＋フォールバック**（候補=[第一選択, pdfcpu, passthrough]から「入力以下で最小」を採用）。これにより誤分類・肥大化でも**出力が入力を超えない**ことを保証（"don't grow" ガード, ADR-007）。
- **ライセンス: アプリ全体 AGPL-3.0**（ADR-003, `COMPLIANCE.md`）。**新規依存は必ず AGPL 結合可能なライセンスに限る**（MIT/BSD/Apache-2.0 可、GPL-2.0-only 不可）。追加時は `THIRD-PARTY-NOTICES.md` に記録。

実測で確定した主要知見は `docs/benchmark/RESULTS.md`（第1〜5回）に集約。ADRの Preliminary/実測欄と相互参照。

## ベンチマークハーネス（`docs/benchmark/harness/`）

Node（エンジン実行）＋ Python（画質SSIM・頁検証・種別判定）の混成。フルフロー:

```bash
# 1) 合成コーパス生成（権利クリーン。生成PDFはコミットしない）
cd docs/benchmark/corpus && pip install -r requirements.txt && python generate_corpus.py

# 2) エンジン実測（Ghostscript vs pdfcpu, 全サンプル×プリセット）
cd ../harness && npm install && node run-bench.mjs

# 3) 検証・画質（結果ファイルを引数で指定可: results.json / route-results.json / explore-results.json）
python verify_pages.py                 # 頁数維持（要 pip install pypdf）
python compute_ssim.py                 # SSIM＋比較（要 pip install pymupdf scikit-image）

# 4) パラメータ探索（DPI×quality グリッド → SSIM境界）
node explore-params.mjs && python compute_ssim.py explore-results.json && python analyze_explore.py

# 5) コンテンツ別ルーティング実証
python inspect_pdf.py && node route.mjs && python compute_ssim.py route-results.json
```

主要ファイル: `gs-engine.mjs` / `pdfcpu-engine.mjs`（エンジンアダプタ、共通の `compress(bytes, options)`）、`run-bench.mjs`（`--engines gs,pdfcpu` / `--only <id,...>`）、`route.mjs`（ルーティング）、`inspect_pdf.py`（種別判定）、`compute_ssim.py`（PyMuPDF描画＋skimage SSIM）。

### ハマりどころ（このハーネス固有・再発しやすい）

- **Node 24 は WASM ロードで global `fetch` に誤誘導され失敗する**。`Module.instantiateWasm` フックで `wasmBinary` から直接インスタンス化して回避している（gs-engine 参照）。pdfcpu-wasm は事前コンパイルした Module を `p.wasm` に代入して回避。
- **Ghostscript の画像圧縮は `-dPassThroughJPEGImages=false` が必須**。既定(true)は既存JPEGを素通しし圧縮が効かない（同一DPIで削減が倍増）。
- **JPEG quality は `-dJPEGQ` では無効**。QFactor（`setdistillerparams` の `ColorImageDict`/`GrayImageDict`）で制御する。引数順は `…-sOutputFile… -c "<< … >> setdistillerparams" -f /in.pdf`。
- **2値(bitonal)は DCT 化で肥大**。mono は CCITTFax にすべきだが、GSが mono と分類しない入力があり、根本は種別ルーティングで扱う（ADR-010）。
- **Windows コンソールは cp932**。Python 実行時は `PYTHONIOENCODING=utf-8` を付ける（絵文字/日本語の print が落ちる）。
- **Python スクリプトを `inspect.py` と命名しない**（stdlib `inspect` を隠蔽し pymupdf 等が壊れる。実ファイルは `inspect_pdf.py`）。

### コミットしないもの（`.gitignore` 済み・スクリプトで再現）

生成PDF（`docs/benchmark/corpus/<category>/*.pdf`）、`node_modules/`、`out/`、`results*.json` / `explore-results*.json` / `route-results*.json` / `inspect.json`。コーパスの `manifest.json` は参照スナップショットとして残す。生成物は seed 固定で再現でき、Pillow 等の版差で実バイトは変わりうる。

## ADR の対応表（詳細は各ファイル）

001 クライアント側処理 / 002 エンジン選定（実測反映済み）/ 003 AGPLライセンス / 004 配信・COOP/COEP・PWA / 005 NFR・受入基準・メモリ制限 / 006 PDF機能保全ポリシー / 007 MVP・UX・マニュアルモード・肥大化ガード・免責 / 008 探索モード・並列モデル・`CompressionEngine`契約 / 009 フロントエンド技術スタック(Svelte/SvelteKit+Vite+Comlink) / 010 コンテンツ別ルーティング。
