# 調査: WASMのスレッド要否と Cross-Origin Isolation（COOP/COEP）

- Date: 2026-09-01
- Related: ADR-004（配信・セキュリティヘッダ）, ADR-001, ADR-002
- 目的: 「Ghostscript WASM が single-thread で足りるか＝COOP/COEP が必要か」を確定する

## 結論（要約）

- **COOP/COEP（cross-origin isolation）は不要。** 候補エンジンはブラウザで **single-thread 実行**であり、`SharedArrayBuffer` を使わない。
- UIブロッキング回避は **通常の Web Worker + Transferable/ArrayBuffer** で足りる（ADR-001の方針と一致）。`SharedArrayBuffer` は使わない。
- 結果として、配信は単純化でき、**PWA/オフラインの技術的ハードルも大きく下がる**（isolation下のSW制約を回避できる）。

## 根拠

### 1. Ghostscript WASM（第一候補）は single-thread

- laurentmmeyer/ghostscript-pdf-compress.wasm: pthreads/`SharedArrayBuffer`/COOP/COEP の記述なし。圧縮は **通常の Web Worker** で実行し UI をブロックしない構成。実質 single-thread。
- shubhamjha のブラウザ内Ghostscript圧縮記事: threading/`SharedArrayBuffer`/COOP/COEP の言及なし＝**single-thread**。具体数値:
  - WASMバイナリ **約16MB**（初回ロード後は **IndexedDB にキャッシュ**）
  - 24MB PDF で **ピークメモリ 50–60MB**（入力+出力+作業メモリ）
  - 24MB PDF でメインスレッド **3–5秒フリーズ** → **Web Worker必須**
  - `-dSAFER` で仮想FSにファイルアクセスを制限（セキュリティ）

### 2. pdfcpu（Go WASM, 第二候補）も single-thread

- Go の js/wasm はブラウザで**単一スレッド**実行。goroutine はあるが並列実行されず、`SharedArrayBuffer`/COOP/COEP を要求しない。

### 3. COOP/COEP が必要になるのは SharedArrayBuffer を使う場合のみ

- `SharedArrayBuffer`（＝WASM threads/pthreads）は Spectre 対策で cross-origin isolation の背後に置かれ、`COOP: same-origin` + `COEP: require-corp` が必須。
- 逆に **SharedArrayBuffer を使わなければ COOP/COEP は不要**。今回の候補はこれに該当。
- なお Cloudflare Pages では `_headers` で COOP/COEP を付与可能なので、将来 thread 版を採用しても対応はできる（ただし外部リソース読込に制約が出る）。

## 設計への影響

| 項目 | 影響 |
|---|---|
| COOP/COEP | **導入不要**（single-thread採用時）。配信・埋め込みが単純化 |
| Web Worker | 通常のWorker + Transferableで実装（ADR-001通り） |
| WASMキャッシュ | **IndexedDB キャッシュが実証済み**（isolation非依存）。約16MBを初回のみ取得 |
| PWA/オフライン | isolation不要のため SW 制約が減り、実現ハードルが下がる |
| メモリNFR(ADR-005) | 実測 24MB→ピーク50–60MB ≈ 2.5倍。NFRの「入力の4–6倍」は保守的で妥当（WASMランタイム分の底上げは別途考慮） |
| セキュリティ | `-dSAFER` 相当でFSアクセス制限。タイムアウト/サイズ上限と併用（ADR-004/005/007） |

## 残る確認事項（実装フェーズ）

- 採用する具体的な Ghostscript WASM ビルドが thread 無効でコンパイルされているかをビルド成果物で最終確認（`SharedArrayBuffer` 参照が無いこと）。
- IndexedDB キャッシュ vs Service Worker キャッシュのどちらでオフラインを実現するか（ADR-004 §4 / PWA）。
- モバイルでの約16MB WASM ロード時間（ADR-005 初期ロードNFR ≤10秒/モバイル）を実測。

## Sources

- https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm
- https://shubhamjha.com/blog/webassembly-pdf-compression-ghostscript-browser
- https://web.dev/articles/webassembly-threads
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
- https://emscripten.org/docs/porting/pthreads.html
- https://developers.google.com/search/blog/2021/03/sharedarraybuffer-notes
