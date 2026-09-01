# ADR-010: コンテンツ別ルーティング（エンジン/設定の自動選択）

- Status: Accepted（方式を実測で確定。分類精度と設定チューニングは継続改善）
- Date: 2026-09-01
- Related: ADR-002, ADR-005, ADR-006, ADR-007, ADR-008, docs/benchmark/RESULTS.md

## Context

第2〜4回の実測（RESULTS.md）で、単一エンジン/単一設定では全種別を最適化できないことが判明した。

- Ghostscript はスキャン/画像で強力だが、**テキスト/縦書き/2値スキャンでは再生成により肥大化**する。
- pdfcpu は構造最適化でテキストを可逆的に縮小できるが、画像は縮小しない。
- 最適 DPI/画質は**コンテンツ依存**。

そこで、入力PDFを種別判定し、種別ごとに最適なエンジン/設定へ振り分ける（ADR-002 の「用途別エンジン分離」の具体化）。

## Decision

### 1. 分類（inspect）

`inspect`（実装: `docs/benchmark/harness/inspect_pdf.py`）で**実PDFから特徴を導出**して分類する（manifest等のメタに依存しない）。特徴: テキスト量、画像のページ占有率、画像の bpc/成分数、ベクター描画数。

種別: `scan-color` / `scan-gray` / `scan-bitonal` / `mixed` / `vector` / `text`。

### 2. ルーティング方針（第一選択）

| 種別 | 第一エンジン/設定 | 根拠 |
|---|---|---|
| scan-color / scan-gray | Ghostscript（**実効DPI適応**） | 画像圧縮が実効的 |
| scan-bitonal | pdfcpu optimize | GSはDCT化で肥大。CCITT/JBIG2化は今後 |
| mixed | Ghostscript（実効DPI適応） | 画像を圧縮 |
| vector | Ghostscript balanced | ~25%削減 |
| text | pdfcpu optimize | 可逆的に縮小（GSは肥大） |

**GSプリセットの実効DPI適応（アプリ実装 `src/lib/routing/inspect.ts` `pickGsOptions`）**: balanced 固定をやめ、
埋め込み画像の実効解像度（最大画像幅px ÷ ページ幅inch, `info`+`images list` から算出）で選ぶ。
実効DPI ≥ 130 は balanced(100dpi) でダウンサンプル（~76%/SSIM~0.95）、< 130 の低精細は quality(150dpi)で
ダウンサンプルせず JPEG 再エンコードのみ（画質を落とさず縮める）。マニュアル指定(override)があれば優先。

### 3. ガード＋フォールバック（堅牢化）

分類が誤っても・肥大化しても安全にするため、単なる写像でなく候補実行で選ぶ。

```
候補 = [第一選択, pdfcpu, passthrough(=無変換)]
各候補を実行 → 「有効かつ入力以下」で最小サイズを採用
```

- passthrough は常に入力以下なので、**出力が入力を超えることは絶対にない**（肥大化ガード, ADR-007）。
- 誤分類（例: 2値スキャンが color 判定）でも、GSが肥大→ガードで除外→pdfcpu/passthrough へフォールバックし救済。

## 実証結果（RESULTS.md 第5回 / 16サンプル）

- **routed 平均削減率 37.0% vs naive(GS一律 balanced) −55.0%**。
- **naive は 6/16 で肥大、routed は 0/16 で肥大**（ガードが機能）。
- 頁維持 16/16。SSIM: pdfcpu経路=1.000（可逆）、GS経路=平均0.893。
- 種別別: scan-color/gray/photo/mixed→GSで46〜89%削減、text/縦書き/bw→pdfcpuで肥大回避。

## Consequences

### Positive
- 入力を問わず「肥大化しない・種別最適」を保証できる。
- 単一エンジンの弱点（GSのテキスト肥大 / pdfcpuの画像非対応）を相互補完。
- ADR-008 の `inspect()`/`CompressionEngine` 契約で実装でき、探索モードとも整合。

### Negative / 限界
- 候補を複数実行するため**計算コスト増**（本番はブラウザ; 探索並列と同じメモリ律速, ADR-008）。第一選択のみ実行し、ガード違反時のみフォールバックする最適化は可能。
- **分類の限界（更新）**: 旧コーパスの2値スキャンは ReportLab が 1-bit を RGB8 に展開して埋め込むため `scan-bitonal` を検出できなかった。→ **生成器を img2pdf 経由の真の1-bit(CCITT G4)に修正**（`generate_corpus.py` `gen_scan_bitonal`）。アプリの `bpc==1` 判定で正しく `scan-bitonal`→pdfcpu へ振り分けられることを実機確認済み。
  - **なお、RGB/グレースケール8bitで格納された「実質モノクロ」画像**は、メタデータ上は color/gray のため検出できない（ピクセル走査が必要＝ラスタライザ依存の将来課題）。ただしガードで肥大化は防止されるため実害はない。
- **photo は balanced(100dpi)でSSIMが0.90を僅かに割る**（連続調画像）。photo判別 or **SSIM誘導のDPI引き上げ**が望ましい（下記）。

## 今後の改善

- **SSIM誘導ルーティング**: 出力SSIMが閾値未満なら DPI を上げて再試行（photo対策）。
- **連続調(photo)判別**の追加（scan-color の中を細分）。
- **真bitonal対応**: 1-bit検出 → CCITTFax/JBIG2。コーパスに真の1-bitスキャンを追加。
- 第一選択のみ実行＋違反時フォールバックへの最適化（計算コスト削減）。

## Revisit Conditions
- 実データ/実ブラウザで分類精度・コストを検証した時。
- 採用エンジンが変わった時（ADR-002 の最終決定）。
