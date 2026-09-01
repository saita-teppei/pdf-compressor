# ADR-002: PDF圧縮エンジンの選定方針

- Status: Proposed
- Date: 2026-09-01
- Related: ADR-001

## Context

ADR-001では、PDF圧縮を原則としてブラウザ側で実行し、Web Worker + WebAssemblyを処理基盤とする方針を採用した。

本ADRでは、その上で実際にPDFを圧縮するエンジンを選定する。要求事項は以下の通り。

- ブラウザ上のWebAssemblyとして実行できること
- 通常モードで実用的なPDF圧縮ができること
- 複数の圧縮条件を実測する探索モードへ拡張できること
- 可能な限りPDFの構造・テキスト・ベクター情報を維持できること
- スキャンPDFの画像再圧縮・解像度変更を扱えること
- 大容量PDFに対して現実的なメモリ使用量・処理時間で動作すること
- 配布時のライセンス条件がプロジェクトの利用形態と矛盾しないこと

## Candidates

### A. Ghostscript WASM

GhostscriptはPDFの再生成を含む成熟したPDF/PostScript処理系であり、ブラウザ上でWASMとしてPDFを圧縮する実例が存在する。Web Worker内で実行する実装例もある。

長所:

- PDF再生成を含む強力な圧縮能力
- JPEG等の画像ダウンサンプリングを含む既存の圧縮機能を利用しやすい
- スキャンPDFの圧縮との適合性が高い
- 既にブラウザWASMでの実装例がある

短所:

- WASMランタイムおよびバイナリが大きくなりやすい
- PDFを再生成するため、入力PDFによっては構造・機能・メタデータ等への影響を検証する必要がある
- ライセンス条件を配布形態と合わせて精査する必要がある
- 探索モードで多数回実行した場合のブラウザ負荷が懸念される

### B. pdfcpu WASM

pdfcpuはGo製のPDF処理系で、最適化、検証、分割、結合等を提供する。Apache-2.0で公開されている。また、ブラウザ上でWASMとして動かす実例が存在する。

長所:

- Apache-2.0でありライセンス上扱いやすい
- Go製でWASM化しやすい
- PDF構造を維持したまま最適化する方向に適している
- ブラウザ上でのWASM実行実例がある
- ストリーム入出力に対応している

短所:

- Ghostscriptほど画像再圧縮を中心とした汎用的な再生成エンジンではない
- 任意のDPI・JPEG quality等を探索パラメータとして直接扱うには追加実装が必要になる可能性が高い
- 埋め込み画像の置換には制約があり、画像のsoft maskやalpha channel等を含むケースでは制限がある

### C. PDF.js + Canvas + PDF生成ライブラリ

PDF.jsで各ページをレンダリングし、Canvas等で画像処理した後、新しいPDFとして再構築する方式。

長所:

- ブラウザとの親和性が高い
- DPI、画像サイズ、JPEG quality等をアプリ側で完全に制御しやすい
- 探索モードとの相性が非常に良い
- エンジン内部の挙動に依存せず、圧縮アルゴリズムを設計できる

短所:

- テキスト・ベクター・リンク等をページ画像へ変換すると失われる
- 「PDFの圧縮」ではなく「PDFの画像化・再構築」に近い
- 一般的な電子文書PDFには適さない
- PDF再構築処理を自前で設計する必要がある

### D. 独自PDF圧縮エンジン

Rust/C/C++等で必要なPDF処理だけを実装しWASM化する方式。

長所:

- 必要な機能だけに絞れる
- 実行サイズ・性能・メモリ使用量を最適化できる可能性がある
- 独自の探索アルゴリズムを組み込みやすい

短所:

- PDF仕様の実装コストが非常に高い
- PDF互換性を維持するテストコストが大きい
- 初期開発には過剰

## Decision

現時点では単一エンジンに確定せず、**Ghostscript WASMを第一候補、pdfcpu WASMを第二候補として実測比較を行う**。

特に「スキャンPDFの圧縮」と「電子文書PDFの構造維持」を同じエンジンで完全に満たせるとは限らないため、ベンチマークの結果によっては用途別にエンジンを分ける。

第一段階では以下の2系統を比較する。

1. Ghostscript WASMによるPDF再生成型圧縮
2. pdfcpu WASMによるPDF構造最適化 + 必要に応じた画像置換

PDF.js + Canvas方式は、上記2方式ではスキャンPDFの圧縮率・制御性が不足した場合の第三候補とする。

独自エンジンの開発は現段階では採用しない。

## Benchmark Plan

同一PDFセットに対して、少なくとも以下を測定する。

### PDF分類

- スキャン白黒
- スキャングレースケール
- スキャンカラー
- 写真主体PDF
- テキスト主体PDF
- テキスト + 画像混在PDF
- フォント・ベクター主体PDF
- 日本語縦書きPDF

### 指標

- 出力ファイルサイズ
- 元サイズに対する削減率
- 圧縮処理時間
- 初期ロード時間
- ピークメモリ使用量
- WASMバイナリサイズ
- 出力PDFのページ数維持
- テキスト抽出可否
- フォント維持可否
- リンク・しおり・注釈等の維持
- PDFビューアでの表示互換性
- 画像品質

### 圧縮パラメータ

スキャンPDFについては、少なくとも以下を探索する。

- 解像度: 75 / 100 / 150 / 200 / 300 DPI
- JPEG quality: 30 / 40 / 50 / 60 / 70 / 80
- カラー: color / grayscale / monochrome

全組み合わせを常に実行するのではなく、まず代表的なプリセットを比較し、探索モードでは候補数を制限する。

## Architecture Implication

圧縮エンジンはUIから直接呼び出さず、以下の抽象インターフェースを設ける。

```text
CompressionEngine
  ├─ initialize()
  ├─ inspect(input)
  ├─ compress(input, options)
  └─ dispose()
```

これにより、Ghostscript WASMからpdfcpu WASMへ変更してもUI・探索ロジックを再利用できる。

探索ジョブはエンジンに依存しない。

```text
Explorer
  ↓
CompressionEngine
  ↓
Result { size, duration, options, blob }
```

## Consequences

### Positive

- エンジンを交換可能にできる
- 実測結果に基づいて採用を決定できる
- 通常モードと探索モードで同じ圧縮APIを利用できる
- PDF種別によって最適な圧縮方式を選択できる可能性がある

### Negative

- 初期段階で2つ以上のWASM実装を検証する必要がある
- ベンチマーク用PDFセットの準備が必要
- PDFの見た目だけでなく、構造・機能の回帰試験が必要
- エンジンごとに圧縮パラメータの意味が異なるため、完全な共通設定にはできない

## Preliminary Evaluation

現時点の暫定評価は以下の通り。

| 項目 | Ghostscript WASM | pdfcpu WASM | PDF.js + Canvas | 独自実装 |
|---|---:|---:|---:|---:|
| スキャンPDF圧縮 | ◎ | ○ | ◎ | △ |
| 電子文書の構造維持 | ○ | ◎ | × | △ |
| 圧縮パラメータ制御 | ◎ | ○ | ◎ | ◎ |
| 探索モード | ○ | ○ | ◎ | ◎ |
| ブラウザ実績 | ◎ | ○ | ◎ | × |
| ライセンスの扱いやすさ | △ | ◎ | ◎ | △ |
| 実装コスト | ○ | ○ | ○ | × |
| 総合候補 | **第一候補** | **第二候補** | 第三候補 | 不採用 |

この表は実測前の暫定評価であり、最終決定ではない。

### 第1回実測（Ghostscript WASM / Node, docs/benchmark/RESULTS.md）

- スキャン(gray/color)で `/screen` プリセットが**約82%削減**、全出力で頁数維持・有効PDF。「スキャンPDF圧縮 ◎」を裏付け。
- 一方、テキスト主体/縦書きなど**元が小さいPDFは再生成で肥大化**する場合を確認 → 肥大化ガード（ADR-007）で対処。
- ライセンスはパッケージも AGPL-3.0（ADR-003で許容済み）。

### 第2回実測（Ghostscript vs pdfcpu 同条件比較 + SSIM, RESULTS.md）

`@jspawn/ghostscript-wasm`（16.2MB）と `pdfcpu-wasm`（30.1MB）を同一コーパスで比較（SSIM込み、頁維持64/64）。

| 観点 | Ghostscript | pdfcpu |
|---|---|---|
| スキャン/写真の削減 | `/screen` **38.4% @ SSIM 0.925**（`/ebook`約17%,SSIM≈1.0） | **約0.2%**（画像を再圧縮しない） |
| テキスト/構造PDF | **肥大化しがち** | **11〜20%削減, SSIM 1.000**（可逆的構造最適化） |
| 速度(Node参考) | 数百ms〜3s | 高速(平均約89ms) |
| WASMサイズ | 16.2MB | 30.1MB |

- 実測により **暫定評価の「Ghostscript=スキャン◎ / pdfcpu=構造維持◎」を裏付け**。
- **示唆**: 単一エンジンで両立せず、**コンテンツ別ルーティング**（スキャン/画像→Ghostscript、電子文書→pdfcpu/パススルー）＋肥大化ガードが有効。ADRの「用途別エンジン分離」が現実的選択肢として具体化 → **ADR-010で実証済み**（routed 37% vs naive −55%、肥大0/16）。
- SSIM≥0.90（ADR-005）は GS `/screen`（画像系0.925）で達成。
- 未実施: ブラウザ/モバイル実測、明示DPI/quality探索でのSSIM閾値点、フォーム/署名等を含むサンプル。

## Evidence

- GhostscriptをWebAssembly化してブラウザ内でPDF圧縮する実装例: https://shubhamjha.com/blog/webassembly-pdf-compression-ghostscript-browser
- Ghostscript WASMによるWeb Worker圧縮実装例: https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm
- pdfcpu公式: https://pdfcpu.io/about/about/
- pdfcpuのライセンス: Apache-2.0 https://github.com/pdfcpu/pdfcpu
- pdfcpuの画像更新機能: https://pdfcpu.io/images/images_update/
- pdfcpuのWASMブラウザ実装例: https://github.com/LaserKaspar/go-wasm-pdfcpu

## Revisit Conditions

以下の場合に最終的なエンジンを確定する。

- ベンチマークでGhostscript WASMが許容できないメモリ・処理時間となった場合
- Ghostscriptのライセンス条件が配布形態と合わない場合
- pdfcpu WASMだけで必要な画像圧縮品質を達成できることが確認できた場合
- PDF.js + Canvas方式がスキャンPDFで明確に優位となった場合
- 対応PDFの種類が明確になり、用途別エンジン分離が合理的となった場合
