# ベンチマーク計測方法論

- Date: 2026-09-01
- Related: ADR-002, ADR-005（NFR/受入基準）, ADR-006（機能保全）, CORPUS.md

コーパス（CORPUS.md）に対しエンジン／パラメータを実測し、ADR-005の受入基準で合否判定するための計測方法を定める。

## 1. 計測対象

- **エンジン**: Ghostscript WASM（第一候補）, pdfcpu WASM（第二候補）, 必要に応じ PDF.js+Canvas。
- **共通条件**: 同一マシン・同一ブラウザ・同一コーパスで比較。デスクトップとモバイル（実機または近似）双方。

## 2. 圧縮パラメータ

ADR-002準拠。スキャンPDFは以下を探索、まず代表プリセットを比較。

- 解像度: 75 / 100 / 150 / 200 / 300 DPI
- JPEG quality: 30 / 40 / 50 / 60 / 70 / 80
- カラー: color / grayscale / monochrome

## 3. 指標と測定方法

| 指標 | 測定方法 | 対応NFR(ADR-005) |
|---|---|---|
| 出力サイズ | Blob.size | — |
| 削減率 | 1 − 出力/入力 | ≥50%（スキャン/既定） |
| 圧縮処理時間 | `performance.now()` 差分（compress前後） | 10MBスキャン≤10s/25s |
| 初期ロード時間 | WASM取得〜`initialize()`完了 | ≤5s/10s（初回） |
| ピークメモリ | `performance.measureUserAgentSpecificMemory()`／`performance.memory`（取得可能な範囲） | 入力の≤4〜6倍 |
| WASMバイナリサイズ | 配信バイト数 | — |
| ページ数維持 | 出力のページ数＝入力 | 100%必須 |
| テキスト抽出可否 | PDF.jsでテキスト抽出し比較 | ADR-006 |
| フォント維持 | 埋め込みフォントの有無/一致 | ADR-006 |
| リンク/しおり/注釈維持 | 構造抽出で有無確認 | ADR-006 |
| 表示互換性 | 標準ビューアで開けるか（出力軽検証） | 可読性必須 |
| 画質 | **SSIM**（必要に応じPSNR） | SSIM≥0.90（既定） |

### 画質（SSIM/PSNR）の測り方

1. 入力PDFと出力PDFの**同一ページを同一解像度でレンダリング**（PDF.js等でraster化）。
2. 各ページで SSIM を算出、文書全体は平均（必要に応じ最悪値も記録）。
3. 既定プリセットで SSIM ≥ 0.90 を合格ラインとする（ADR-005）。写真/スキャンカテゴリで特に重視。

## 4. 結果スキーマ

`docs/benchmark/results/*.json` に保存。

```json
{
  "engine": "ghostscript-wasm",
  "engineVersion": "…",
  "device": "desktop",
  "sampleId": "scan-color-medium-01",
  "options": { "dpi": 150, "jpegQuality": 60, "color": "color" },
  "inputBytes": 8123456,
  "outputBytes": 3120000,
  "reductionRatio": 0.616,
  "compressMs": 4200,
  "initMs": 3800,
  "peakMemoryBytes": 42000000,
  "pagesPreserved": true,
  "textExtractable": false,
  "ssimMean": 0.93,
  "ssimMin": 0.89,
  "warnings": []
}
```

## 5. 合否判定

- 各サンプル×プリセットの結果を ADR-005 の閾値へ照合し PASS/FAIL を付与。
- カテゴリ別に集計し、エンジンの得手不得手を可視化（ADR-002の用途別分離判断に使用）。
- 回帰: エンジン/パラメータ変更時に同一コーパスで再実行し、閾値割れを検出。

## 6. ハーネス構成（方針）

- ブラウザ実測（本番同等環境）を主とし、Web Worker内で `CompressionEngine`（ADR-008の契約）を呼ぶ。
- `manifest.json`（CORPUS.md）を入力にジョブを生成し、結果JSONを出力。
- 探索は無制限展開せず代表プリセット→絞り込み（ADR-001/008）。

## 7. 未確定

- モバイル実測環境（実機/エミュレーション）の選定。
- ピークメモリAPIの利用可否（ブラウザ差）と代替計測。
- SSIM算出ライブラリ／実装（AGPL結合可否を点検: COMPLIANCE.md §4）。
