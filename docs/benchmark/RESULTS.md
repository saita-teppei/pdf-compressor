# ベンチマーク結果（第1回・Ghostscript WASM / Node実測）

- Date: 2026-09-01
- Related: ADR-002, ADR-005, ADR-006, ADR-007, METHODOLOGY.md, CORPUS.md
- エンジン: `@jspawn/ghostscript-wasm` 0.0.2（AGPL-3.0、gs.wasm 16.2MB）
- 実行環境: **Node v24（デスクトップ）**。ブラウザ実測は未実施（後段・要Playwright）。
- コーパス: 合成 small+medium 16サンプル（generate_corpus.py）
- 実行: `node run-bench.mjs`（screen/ebook/printer 各プリセット、計48圧縮）

> 注意: これは**第1回の予備実測**。処理時間・メモリはNode値でブラウザとは異なる。削減率・頁維持・妥当性はエンジン依存で移植性が高い。SSIM（画質）は未計測。

## サマリ: 平均削減率（category × preset）

| category | screen(≈72dpi) | ebook(≈150dpi) | printer(≈300dpi) |
|---|---:|---:|---:|
| scan-bw | 25.1% | 9.4% | 7.7% |
| scan-gray | **50.9%** | 19.8% | 19.5% |
| scan-color | **50.8%** | 19.8% | 19.5% |
| photo | 26.9% | 19.8% | 19.5% |
| text | **-335%** | -335% | -355% |
| mixed | 39.9% | 9.2% | 8.0% |
| vector | 23.4% | 23.5% | 18.8% |
| vertical-ja | **-215%** | -215% | -231% |

medium単体では scan-gray/color の `/screen` が **7.7MB→1.4MB（82%削減）**、mixed `/screen` が 3.0MB→0.6MB（80%）。

- 全48出力が **exit=0・有効な%PDF・頁数維持（48/48）**（verify_pages.py）。

## 重要な知見

### 1. スキャン/画像PDFは Ghostscript が強力（ADR-002 ◎を裏付け）
- scan-gray/color medium で `/screen` が **82%削減**。ADR-002の「スキャン重視で70–85%」という記述と整合。
- 解像度が効く: 合成元が150dpiのため、`/ebook`(150) `/printer`(300) は再ダウンサンプルが効かず約20%止まり。`/screen`(72) で大きく縮む。→ **プリセット（解像度）が最大のレバー**。

### 2. テキスト/縦書きPDFは「圧縮で肥大化」する（要ガード）
- text/vertical-ja で **出力が入力より大きくなる**（例: 0.01MB→0.06MB）。pdfwrite による再生成で構造・フォント処理のオーバーヘッドが載るため。
- 合成コーパス特有の面（極小・非埋め込みCIDフォント）もあるが、**「再圧縮すると増えることがある」現象自体は一般的**。
- → **プロダクト要件**: 出力が入力以上なら**元ファイルを採用して肥大化を防ぐ**（"don't grow" ガード）。UIでも「これ以上圧縮できません」と提示。ADR-007（出力ハンドリング）へ反映済み。

### 3. 処理時間（Node参考値）
- medium で概ね 0.5–3.3秒。初期化（wasmインスタンス化）は毎回約20ms と安価。
- ブラウザ・モバイル実測はADR-005 NFR（10MBスキャン≤10s/25s）に対して後段で確認する。

## 未計測・次段

- **SSIM（画質）**: 入出力ページをラスタライズして比較（METHODOLOGY §3）。要ラスタライザ。
- **pdfcpu WASM（第二候補）**の同条件比較（ADR-002）。
- **ブラウザ実測**（Playwright、処理時間・ピークメモリの本番値、モバイル）。
- **明示DPI/JPEG quality の探索**（現状はプリセットのみ計測）。
- フォーム/署名/タグ付き等を含むサンプル追加（ADR-006検証・現コーパス未収録）。

## 再現手順

```bash
cd docs/benchmark/corpus && pip install -r requirements.txt && python generate_corpus.py
cd ../harness && npm install && node run-bench.mjs
python verify_pages.py     # 頁維持検証 (pip install pypdf)
```

---

# 第2回: Ghostscript vs pdfcpu 同条件比較（SSIM込み）

- Date: 2026-09-01
- エンジン: `@jspawn/ghostscript-wasm`（AGPL-3.0, wasm **16.2MB**） vs `pdfcpu-wasm`（本体 Apache-2.0/ラッパーMIT, wasm **30.1MB**）
- 条件: GS=screen/ebook/printer、pdfcpu=optimize。同一コーパス16サンプル、計64圧縮。
- SSIM: 入出力の先頭最大3ページを100dpiでグレースケール化し `skimage.structural_similarity` で算出（PyMuPDF描画）。
- 全64出力が **頁維持（64/64）・有効PDF**。

## スキャン/写真カテゴリ（画像圧縮の要点）

| engine | preset | 平均削減率 | 平均SSIM |
|---|---|---:|---:|
| ghostscript | screen | **38.4%** | **0.925** |
| ghostscript | ebook | 17.2% | 1.000 |
| ghostscript | printer | 16.5% | 1.000 |
| pdfcpu | optimize | 0.2% | 1.000 |

## 全カテゴリ平均（テキスト肥大化の影響で参考値）

| engine | preset | 平均削減率 | 平均SSIM | 平均ms(Node) |
|---|---|---:|---:|---:|
| ghostscript | screen | -41.7% | 0.887 | 856 |
| ghostscript | ebook | -56.0% | 0.926 | 639 |
| ghostscript | printer | -61.6% | 0.926 | 640 |
| pdfcpu | optimize | +3.5% | 1.000 | 89 |

> 全カテゴリ平均でGSが負になるのは、テキスト/縦書きの極小PDFをGSが肥大化させるため（第1回知見）。画像系の実力は上のスキャン/写真表で見る。

## 比較からの結論

1. **画像/スキャンはGhostscriptが唯一実効的**。GS `/screen` が **38.4%削減 @ SSIM 0.925（ADR-005のSSIM≥0.90を満たす）**。`/ebook` `/printer` は約17%だが SSIM≈1.0（視覚的に無変化=安全側）。pdfcpu は約0%（画像を再圧縮しない）。
2. **テキスト/構造はpdfcpuが優位**。pdfcpu optimize はテキストPDFを 11〜20% 削減（SSIM 1.000, 完全可逆的な構造最適化）。**同じPDFをGSは肥大化させる**。→ ADR-002「pdfcpu ◎ 構造維持」を裏付け。
3. **アーキテクチャ示唆（用途別ルーティング）**: 「スキャン/画像→Ghostscript、電子文書→pdfcpu（または無変換パススルー）」の**コンテンツ別ルーティング**が有効。加えて **肥大化ガード**（出力≥入力で元を採用, ADR-007）で安全化。
4. **速度・サイズ**: pdfcpu は高速（平均89ms）だが wasm 30MB と大きい。GS は 16MB で画像圧縮可能だが遅め（画像系で数百ms〜3s）。初期ロードNFR（ADR-005）にwasmサイズ差が効く。
5. SSIM閾値0.90はGS `/screen`（画像系0.925）で達成。より積極圧縮（低DPI/低quality）時にSSIMがどこで0.90を割るかは、明示DPI/quality探索で今後確認。

## 第2回の再現

```bash
cd docs/benchmark/harness && npm install    # @jspawn/ghostscript-wasm, pdfcpu-wasm
node run-bench.mjs                            # 両エンジン
python verify_pages.py                        # 頁維持 (pypdf)
python compute_ssim.py                        # SSIM＋比較 (pymupdf, scikit-image)
```

---

# 第3回: DPI×quality 探索（プリセット詰め / SSIM境界）

- Date: 2026-09-01
- 対象: 画像系 medium（scan-color/gray, photo, mixed）。グリッド dpi[72,100,150,200,300] × q[40,60,80]。
- 実行: `node explore-params.mjs` → `python compute_ssim.py explore-results.json` → `python analyze_explore.py`

## 削減率 / SSIM（抜粋）

| category | dpi72 | dpi100 | dpi150 |
|---|---|---|---|
| scan-color | 86.1% / **0.902** | 75.8% / 0.954 | 20.0% / 1.000 |
| scan-gray | 86.3% / 0.893 | 76.1% / **0.953** | 20.0% / 1.000 |
| photo(合成ノイズ) | 95.3% / 0.541 | 89.0% / 0.715 | 20.0% / 1.000 |
| mixed | 83.6% / 0.856 | 73.3% / 0.875 | 18.2% / 0.889 |

（元が150dpiのため dpi≥150 は再サンプルされず一律 ~20%。SSIM=1.0）

## 重要な知見

1. **JPEG quality ノブが無効**: q40/60/80 で**サイズ・SSIMとも完全に同一**。この Ghostscript ビルドは `-dJPEGQ`（+AutoFilter off/DCTEncode 指定下でも）を反映しない。**DPIが唯一の実効的な画像レバー**。
   - → マニュアルモードは **DPIを主コントロール**にする。quality は現ビルドでは公開しない（またはベストエフォート表記）。別機構（setdistillerparams / 別ビルド）は今後の課題。
2. **SSIM≥0.90 の境界はコンテンツ依存**（単一プリセットで最適化できない）:
   - scan-color: **72dpi でも 0.902**（86%削減）
   - scan-gray: 72dpi は 0.893 で割れる → **100dpi 推奨**（76%削減, 0.953）
   - photo（合成ノイズ=最悪ケース）: 150dpi 未満は 0.90 を割る。実写真は改善見込みだが要実データ
   - mixed: テキスト頁の影響で最大 0.889 → 積極ダウンサンプルは不利
   - → **コンテンツ別ルーティング＋コンテンツ別DPI** の裏付け（次段で実証）。
3. 合成コーパス依存の注意: 特に photo は高周波ノイズで SSIM に厳しい。実データで再評価が必要。

## データに基づく推奨プリセット（暫定・ADR-008へ反映）

| プリセット | DPI | 位置づけ | スキャンでの目安 |
|---|---:|---|---|
| max（最小サイズ） | 72 | 積極圧縮 | ~86%削減, SSIM≈0.89–0.90 |
| balanced（既定） | 100 | サイズ/画質両立 | ~76%削減, SSIM≈0.95 |
| quality | 150 | 画質優先/構造維持 | ~20%（再エンコードのみ, SSIM≈1.0） |

## 第3回の再現

```bash
node explore-params.mjs
python compute_ssim.py explore-results.json
python analyze_explore.py            # SSIM≥0.90 の最大削減設定を表示
```

---

# 第4回: 画像エンコード機構の見直し（PassThrough / quality / 非JPEG）

- Date: 2026-09-01
- 動機: 「JPEG以外の形式なら quality を触れるのでは？」という仮説の検証。

## 判明した3点

### 1. 真犯人は `PassThroughJPEGImages=true`（既定）
既存JPEG画像を**再エンコードせず素通し**するため、DPI≥源では圧縮が効いていなかった。**`-dPassThroughJPEGImages=false` で再エンコードさせると同一DPIで削減が倍増**（scan-color 150dpi: 20% → **50%**、photo 150dpi: 20% → **60%**）。エンジンに恒常採用。

### 2. quality は `-dJPEGQ` では無効、**QFactor（setdistillerparams）で有効**
`-dJPEGQ` はこのビルドで不変だが、`ColorImageDict << /QFactor .. >>` を setdistillerparams で渡すと**単調に効く**。マニュアルモードの quality ノブを QFactor 経由で実装（quality 1..100 → QFactor 3.0..0.1）。

| scan-color | q40 | q60 | q80 |
|---|---|---|---|
| 72dpi | 86.4%/0.892 | 86.2%/0.898 | **86.0%/0.905** |
| 150dpi | 51.3%/0.988 | 50.9%/0.990 | 50.0%/0.991 |

| photo | q40 | q60 | q80 |
|---|---|---|---|
| 150dpi | 60.8%/0.895 | **60.0%/0.913** | 57.9%/0.936 |

→ quality は**SSIM境界をまたぐ微調整**に有効（例: scan-color 72dpi は q80 で SSIM 0.90 を回復しつつ 86% 削減）。

### 3. 非JPEG形式
- **Flate（可逆）**: 写真調では逆に肥大（scan-color 7.8→12.7MB）。可逆ゆえ quality ノブ無し。
- **JPXEncode（JPEG2000）**: このビルドは**非対応**（`rangecheck in .putdeviceprops`）。
- 結論: 非JPEGでは quality を得られない。**quality は DCT + QFactor で実装**するのが正解。

## SSIM≥0.90 を満たす最大削減（改善後）

| category | dpi | q | 削減率 | SSIM |
|---|---:|---:|---:|---:|
| scan-color | 72 | 80 | **86.0%** | 0.905 |
| photo | 150 | 60 | **60.0%** | 0.913 |

## 既知の課題（次段=コンテンツ別ルーティングへ）
- **2値(bw)スキャンが肥大**: 強制DCT/Bicubicが1-bit画像に不適（CCITT/JBIG2にすべき）。このGSビルドは合成bwをmono分類せずgray扱いにするため、`-dMonoImageFilter=/CCITTFaxEncode` だけでは効かず、**画像タイプ判別＝ルーティング**が要る。当面は肥大化ガード（ADR-007）で元を採用。
- **テキスト/縦書きの肥大**も同様に don't-grow ガードで対処。

## 第4回の反映
エンジン(gs-engine.mjs)を更新: `PassThroughJPEGImages=false` 恒常化、quality→QFactor、mono用CCITT指定。プリセットは max(72)/balanced(100)/quality(150)。

---

# 第5回: コンテンツ別ルーティング実証（ADR-010）

- Date: 2026-09-01
- 手順: `python inspect_pdf.py`（実PDFから種別判定）→ `node route.mjs`（種別→エンジン/設定＋ガード＋フォールバック）→ `python verify_pages.py route-results.json` / `python compute_ssim.py route-results.json`

## 結果（16サンプル）

| 指標 | routed（コンテンツ別） | naive（GS balanced 一律） |
|---|---:|---:|
| 平均削減率 | **37.0%** | **−55.0%** |
| 肥大したサンプル | **0 / 16** | 6 / 16 |
| 頁維持 | 16 / 16 | — |

- **naive は bw/text/縦書きで大きく肥大**（例 text −648%, 縦書き −325%, bw −270%）。routed はこれらを pdfcpu 経路に振り分け肥大回避。
- scan-color/gray/photo/mixed → GS で 46〜89% 削減。text/縦書き/bw → pdfcpu で肥大回避（可逆, SSIM 1.000）。
- GS経路のSSIM平均0.893（photoが100dpiで0.90を僅かに割るため。文書スキャンは高SSIM）。

## 分類（inspect の導出結果）

- 正判定: scan-gray/scan-color/text/mixed/vector/縦書き(→text)。
- **限界**: 合成bwが1-bitでなくRGB埋め込みのため `scan-bitonal` は検出できず `scan-color` 判定 → GS肥大 → **フォールバックで pdfcpu 採用**（ガードが救済）。真の1-bitスキャンでの検証が必要。

## 示唆
- ルーティング＋ガード＋フォールバックで **「入力を問わず肥大化しない・種別最適」** を実証。
- 改善余地: SSIM誘導のDPI引き上げ（photo対策）、連続調判別、真bitonal対応（→ADR-010）。

## 第5回の再現
```bash
python inspect_pdf.py
node route.mjs
python verify_pages.py route-results.json
python compute_ssim.py route-results.json
```

---

# 第6回: ブラウザ実測（Web Worker + Comlink 経路の検証 / PoC）

- Date: 2026-09-01
- 動機: 第1〜5回はすべて **Node 実測**であり、本番であるブラウザ実行経路（WASM を Web Worker 内でインスタンス化 → Comlink 駆動）と、そこでの処理時間・メモリ・初期ロードが**未検証**だった。アプリ本体（ADR-009）着手前にここを de-risk する。
- ハーネス: `docs/benchmark/browser/`（Vite + TypeScript + Web Worker + Comlink + Playwright）。エンジンアダプタは `harness/gs-engine.mjs` の `toGsArgs` を移植（圧縮引数は Node 版と同一）。wasm は自前 fetch(+IndexedDB キャッシュ)→事前 `compile`→毎回 `instantiate`。
- 実行: Chromium（Playwright）。desktop=全16サンプル×4条件（GS max/balanced/quality + pdfcpu optimize=計64）。mobile=デバイスエミュレーション+CDP CPU 4x スロットルで代表4サンプル×2条件（**実機ではない参考値**）。
- 実機: hardwareConcurrency=12, deviceMemory=16（計測機のデスクトップ値）。

## 機能検出（selfCheck）— ADR-004/008 の前提を実機確認

| 項目 | 実測 | 含意 |
|---|---|---|
| `crossOriginIsolated` | **false** | COOP/COEP 未導入で動作（ADR-004 を実証） |
| `SharedArrayBuffer` | **undefined** | COI 無しでは SAB 自体が無効。single-thread 前提が成立（ADR-004 §47 の SAB 不使用を実機確認） |
| `performance.measureUserAgentSpecificMemory` | **利用不可** | COI 必須のため。**ADR-008 §4 のプール主シグナルが使えない**（後述の代替が必要） |
| `performance.memory` | 利用不可（headless） | 補助シグナルも当てにできない |

## 削減率・SSIM は Node 実測と一致（移植の等価性）

`verify_pages.py` / `compute_ssim.py` に browser-results.json を渡して検証:

- **頁維持 64/64 OK**、全出力が有効PDF（exitCode=0）。
- 削減率が Node と一致: scan-gray-medium max **86.3%**、scan-color-medium max **86.1%**、photo-medium max **95.3%**（第3回と同値）。pdfcpu は全カテゴリ可逆（SSIM 1.000）。
- SSIM 同条件比較（全16サンプル, 100dpi grayscale）:

| engine | preset | avg_red | avg_SSIM | scan/photoのみ SSIM |
|---|---|---:|---:|---:|
| ghostscript-wasm | max(72dpi) | -30.7% | 0.814 | 0.787 |
| ghostscript-wasm | balanced(100dpi) | -55.0% | 0.870 | **0.893** |
| ghostscript-wasm | quality(150dpi) | -71.8% | 0.891 | 0.933 |
| pdfcpu-wasm | optimize | +3.5% | **1.000** | 1.000 |

→ **ブラウザ移植でエンジン挙動は Node と等価**（scan/photo balanced SSIM 0.893 は第5回 GS 経路と一致）。全カテゴリ平均が負なのは text/縦書きの肥大（第1回知見）で、本番はルーティング（ADR-010）で回避する。

## 処理時間（実ブラウザ, desktop）— NFR ≤10s を満たす

| サンプル(入力) | max | balanced | quality |
|---|---:|---:|---:|
| scan-color-medium (7.8MB) | 959ms | 1231ms | 1187ms |
| scan-gray-medium (7.7MB) | 625ms | 768ms | 834ms |
| photo-medium (9.3MB) | 667ms | 826ms | 1009ms |
| mixed-medium (3.0MB) | 1252ms | 1358ms | 1275ms |
| text-medium (40頁, 0.1MB) | 2864ms | 2783ms | 2865ms |

- ~10MB 級スキャン（scan-color/photo medium）で **≤1.3秒**。ADR-005 の「10MB スキャン ≤10秒(desktop)」を**大きくクリア**。
- 最も遅いのは text-medium（40頁）の GS 2.8秒だが、これは pdfwrite 全頁再生成のコスト。本番では text→pdfcpu（90ms）へルーティングするため実害なし。
- pdfcpu optimize は全て ≤160ms。
- **mobile（エミュレーション+CPU4x, 参考値）**: scan-color balanced 865ms / photo 867ms / mixed 1408ms / text 3240ms。NFR ≤25秒(mobile)内。**ただしエミュレーションは実 CPU/メモリを反映しない**ため、実機（中位 Android/iOS）での再計測が必要。

## 初期ロード・キャッシュ（ADR-004 §3）

| エンジン | cold fetch | compile | warm(IndexedDB) | wasm |
|---|---:|---:|---:|---:|
| ghostscript-wasm | 122ms | 12ms | 17ms | 16.2MB |
| pdfcpu-wasm | 153ms | 25ms | 28ms | 30.1MB |

- **IndexedDB キャッシュは機能**（2回目は fetch→IDB 取得で ~17–28ms）。`WebAssembly.compile` は 12–26ms と安価。
- **重要な限界**: これは **localhost 配信**の値であり、初回訪問時の 16MB/30MB の**実ネットワーク転送時間は含まない**。ADR-005 の「初回ロード ≤5s/≤10s」は実配信（Brotli/gzip, ADR-004）＋回線に依存するため、**デプロイ環境またはネットワークスロットル下での再計測が残**（本 PoC は compile+cache が安価であることのみ確定）。

## メモリ（WASM 線形メモリ = ピーク作業メモリ代理値）

- `measureUserAgentSpecificMemory` が使えないため、**圧縮後の WASM 線形メモリ `buffer.byteLength`** を代理値として採取。
- GS の線形メモリは入力によらず **64MiB（67MB）にほぼ固定**、40頁の text-medium のみ 80MiB（81MB）。9.3MB 入力でも 67MB（≈入力の 7.2倍だが**絶対値は小**）。
- → **知見**: GS の作業メモリは入力に線形でなく、**固定ベースライン（~64–80MB）が支配的**。ADR-008 の `perWorkerBytes = WASM_BASELINE + inputBytes*PEAK_FACTOR` は小入力で過小評価する。**「固定 ~80–100MB/worker + 大入力での増分」モデルの方が実態に近い**。ただし線形メモリは量子化された粗い上限であり、JS/DOM 分は別。

## キャンセル（ADR-008 §5）

- 大サンプルの GS 圧縮を開始 → 40ms 後に `Worker.terminate()`。**元 Promise は解決せず中断成功**（`resolvedAfterTerminate=false`）。
- その後、新規 Worker で復旧して小圧縮が成功（361ms）。**terminate による確実中断＋Worker 補充が実ブラウザで機能**。

## Go / No-Go 判定

| 論点 | 判定 | 根拠 |
|---|---|---|
| Web Worker + Comlink 経路 | **GO** | 全64圧縮が成功、コンソールエラー無し |
| IndexedDB WASM キャッシュ | **GO** | 温状態 ~17–28ms |
| COI 無しのメモリ計測手段 | **GO（代替確定）** | measureUserAgentSpecificMemory 不可 → 線形メモリ byteLength + 固定予算モデル + 失敗検知バックオフ |
| モバイル・実ネットワーク初回ロード | **保留（要実機/実配信）** | エミュレーションと localhost では未確定。処理時間・compile・cache は良好 |

## ADR への反映

- **ADR-008 §4**: `measureUserAgentSpecificMemory()` は COI 必須で本構成では**使用不可**。プール律速は「固定 ~80–100MB/worker 予算 + 失敗検知バックオフ」に改める。`perWorkerBytes` の入力線形モデルは小入力で過小評価する点を追記。
- **ADR-004**: `SharedArrayBuffer` が undefined であることを実機確認（single-thread 前提が成立）。IndexedDB キャッシュの温取得が安価であることを確認。**実ネットワーク初回ロードの計測が残**。
- **ADR-005**: desktop の処理時間 NFR（10MB スキャン ≤10s）は実ブラウザで達成（≤1.3s）。モバイル実機・実配信初回ロードは未達確認事項として残す。

## 第6回の再現

```bash
# 前提: コーパス生成済み（docs/benchmark/corpus/generate_corpus.py）
cd docs/benchmark/browser && npm install && npx playwright install chromium
npx playwright test browser-bench.spec.ts --project=desktop   # browser-results.json
npx playwright test browser-bench.spec.ts --project=mobile    # browser-results-mobile.json（参考値）

cd ../harness
python verify_pages.py ../browser/browser-results.json        # 頁維持
python compute_ssim.py ../browser/browser-results.json        # SSIM + Node等価性比較
```
