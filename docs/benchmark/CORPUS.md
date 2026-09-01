# ベンチマーク用PDFコーパス仕様

- Date: 2026-09-01
- Related: ADR-002（Benchmark Plan）, ADR-005（NFR/受入基準）

エンジン比較（Ghostscript WASM / pdfcpu WASM / PDF.js+Canvas）を公平・再現可能に行うためのテストPDFコーパスを定義する。

## 1. 権利方針（重要）

- **権利上クリーンな素材のみ**を使用する。第三者の著作物・実在の機微情報を含むPDFは使用しない。
- 使用可能な素材:
  - 自作／合成生成したPDF
  - パブリックドメイン、CC0、明示的に再配布可能なライセンスの文書
  - 権利表示が明確なオープンデータ
- 各サンプルの**出所とライセンスをマニフェストに必須記録**する（§4）。
- コーパスをリポジトリへ含める場合、そのライセンスがプロジェクト（AGPL, ADR-003）と矛盾しないことを確認する。矛盾する場合は取得スクリプトのみ配布し実体は含めない。

## 2. 分類（ADR-002準拠）

各カテゴリに複数サンプル（小・中・大サイズ）を用意する。

| ID | カテゴリ | 主眼 |
|---|---|---|
| scan-bw | スキャン白黒 | 2値画像の再圧縮・解像度変更 |
| scan-gray | スキャングレースケール | グレー画像のダウンサンプリング |
| scan-color | スキャンカラー | カラー画像のJPEG再圧縮 |
| photo | 写真主体 | 高情報量画像の画質/サイズ両立 |
| text | テキスト主体 | テキスト・フォント維持 |
| mixed | テキスト＋画像混在 | 一般的電子文書 |
| vector | フォント・ベクター主体 | ベクター/図形の維持 |
| vertical-ja | 日本語縦書き | 日本語フォント・縦書き維持 |

## 3. サイズ帯

NFR（ADR-005）の上限に対して代表点を置く。

- 小: 〜1 MB
- 中: 5〜10 MB（処理時間NFRの基準: 10MBスキャン ≤ 10秒/デスクトップ）
- 大: 50〜100 MB（デスクトップ上限付近／モバイル上限30MB付近も1点）

## 4. マニフェスト

`docs/benchmark/corpus/manifest.json` に全サンプルを登録する。スキーマ:

```json
{
  "samples": [
    {
      "id": "scan-color-medium-01",
      "path": "corpus/scan-color/medium-01.pdf",
      "category": "scan-color",
      "sizeBytes": 8123456,
      "pages": 12,
      "source": "self-generated",
      "license": "CC0-1.0",
      "notes": "300dpiカラースキャン相当を合成",
      "features": ["images"],
      "hasText": false,
      "hasSignature": false
    }
  ]
}
```

- `source` / `license` は必須（§1権利方針）。
- `features` はADR-006の保全マトリクス検証に使う（text/vector/annotations/bookmarks/links/forms/signature/tagged/attachments/xmp 等）。

## 5. ディレクトリ構成

```text
docs/benchmark/
  CORPUS.md          （本書）
  METHODOLOGY.md     （計測方法・指標・閾値）
  corpus/
    manifest.json
    scan-bw/ scan-gray/ scan-color/ photo/ text/ mixed/ vector/ vertical-ja/
```

## 6. 命名規約

`<category>-<size>-<seq>.pdf`（例: `text-large-02.pdf`）。マニフェストの `id` と一致させる。

## 7. 整備手順

1. カテゴリ×サイズ帯ごとにサンプルを用意（自作/合成優先）。
2. 各サンプルの出所・ライセンス・特徴を確認し `manifest.json` に登録。
3. 権利上リポジトリに含められない素材は、生成/取得スクリプトのみ管理。
4. METHODOLOGY.md の計測ハーネスから `manifest.json` を読み込んで実行。

## 8. 生成器（合成コーパス）

`corpus/generate_corpus.py` が8分類のサンプルPDFと `manifest.json` を**手続き的に生成**する。内容はすべて合成（CC0）で、第三者著作物・実在の機微情報を含まない。スキャン/写真系はラスタライズ（ピクセルのみ）、テキスト層はCIDフォント参照（フォント実体を埋め込まない）。**生成PDFはコミットしない**（`.gitignore`）。スクリプトで再現する。

```bash
cd docs/benchmark/corpus
pip install -r requirements.txt      # reportlab, pillow
python generate_corpus.py            # small + medium を生成（既定, seed固定）
python generate_corpus.py --large    # large(50-100MB相当)も生成
python generate_corpus.py --sizes small
```

生成物の例（small+medium, 16サンプル計約31MB。実バイトはPillow版で変動）:

| id | 頁 | 実サイズ | 特性（検証済み） |
|---|---:|---:|---|
| scan-bw-medium-01 | 16 | 1.5 MB | 画像のみ（テキスト抽出0） |
| scan-gray-medium-01 | 16 | 7.7 MB | 画像のみ |
| scan-color-medium-01 | 16 | 7.8 MB | 画像のみ |
| photo-medium-01 | 8 | 9.3 MB | 高エントロピー画像 |
| text-medium-01 | 40 | 0.1 MB | テキスト抽出可・しおり40 |
| mixed-medium-01 | 13 | 3.0 MB | テキスト＋画像＋しおり |
| vector-medium-01 | 5 | 0.1 MB | ベクター主体 |
| vertical-ja-medium-01 | 5 | 0.03 MB | 日本語縦書き・テキスト抽出可 |

> フォーム(AcroForm/XFA)・電子署名・添付・タグ付き構造の合成は現状スコープ外（`hasSignature:false` 等）。ADR-006の該当項目検証には、別途これらを含むサンプルの追加が必要。
