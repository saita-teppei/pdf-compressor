# ADR-008: 探索モード実行・並列モデルとCompressionEngine契約

- Status: Accepted（中核設計を確定。既定値の実測チューニングとエンジン別マッピング実装は残）
- Date: 2026-09-01
- Related: ADR-001, ADR-002, ADR-005, ADR-006, ADR-007
- 前提調査: docs/research/wasm-threading-coi.md

## Context

ADR-001は探索モードで「候補数の上限を設ける」とするのみで実行モデルが未設計だった。ADR-002の `CompressionEngine` 抽象は方向として妥当だが、UX（進捗・キャンセル: ADR-007）、機能保全の事前明示（ADR-006）、メモリ制限（ADR-005）を満たす具体的な契約が欠けていた。

**重要な前提（調査で確定）**: 候補エンジン（Ghostscript / pdfcpu）はブラウザで **single-thread 実行**。真の並列化には **Web Worker を複数**立て、各Workerが**独自にWASMをインスタンス化**する必要がある。Ghostscript WASMは約16MB、24MB PDFでピーク50–60MBの作業メモリを消費する（wasm-threading-coi.md）。したがって**探索の並列度はCPUではなくメモリで律速**される。本ADRはこれを軸に設計する。

## Decision

### 1. CompressionEngine 契約（TypeScript）

UI・Explorerから使う**エンジン非依存の共通契約**。エンジン差はアダプタ内に隠蔽する。

```ts
type ColorMode = 'color' | 'grayscale' | 'monochrome';
type PresetName = 'screen' | 'ebook' | 'printer' | 'prepress' | 'max-compression';

/** UI/Explorerが扱う正規化済みオプション（エンジン非依存） */
interface CompressionOptions {
  preset?: PresetName;       // 指定時は下記を既定展開（§3）
  dpi?: number;              // 画像ダウンサンプリング解像度: 75|100|150|200|300
  jpegQuality?: number;      // 1..100（例: 30..80）
  colorMode?: ColorMode;
  stripMetadata?: boolean;   // XMP/Info除去（ADR-006・プライバシー）
}

/** ADR-006の事前明示に使う含有要素検出 */
interface PdfFeatureFlags {
  hasText: boolean; hasVector: boolean; hasImages: boolean;
  hasSignature: boolean;      // 圧縮で無効化される（要警告）
  hasAcroForm: boolean; hasXFA: boolean;
  hasAnnotations: boolean; hasBookmarks: boolean; hasLinks: boolean;
  hasTaggedStructure: boolean; hasLayers: boolean;
  hasAttachments: boolean; hasXMPMetadata: boolean;
}

interface InspectResult {
  pageCount: number;
  sizeBytes: number;
  pdfVersion?: string;
  encrypted: boolean;                 // 暗号化PDFの受入/拒否判断に使用
  features: PdfFeatureFlags;
  estimatedPeakMemoryBytes?: number;  // プールサイジングの入力（§4）
}

interface CompressProgress {
  phase: 'init' | 'reading' | 'compressing' | 'finalizing';
  ratio?: number;             // 0..1（determinate）。不明ならundefined（indeterminate）
  page?: number; pageCount?: number;
}

interface CompressWarning { code: string; message: string; } // 例: 'signature-removed'

interface CompressResult {
  blob: Blob;
  inputBytes: number; outputBytes: number;
  reductionRatio: number;     // 1 - out/in
  durationMs: number;
  pagesPreserved: boolean;    // 出力軽検証（ADR-005/007）
  peakMemoryBytes?: number;
  warnings: CompressWarning[];
}

interface CompressCall {
  onProgress?: (p: CompressProgress) => void;
  signal?: AbortSignal;       // キャンセル（§5）
}

interface CompressionEngine {
  readonly id: 'ghostscript-wasm' | 'pdfcpu-wasm' | string;
  initialize(): Promise<void>;
  inspect(input: Uint8Array | Blob): Promise<InspectResult>;
  compress(input: Uint8Array | Blob, options: CompressionOptions, call?: CompressCall): Promise<CompressResult>;
  dispose(): Promise<void>;   // WASMメモリを明示解放（ADR-005）
}
```

### 2. Worker配置と通信

- 各エンジンインスタンスは **Web Worker 内**で動作（ADR-001）。メインへ `Comlink` でPromiseベースRPC公開する。
- 入力は `ArrayBuffer` を **Transferable** で渡し、コピーを避ける（`SharedArrayBuffer` は使わない: 調査で不要と確定）。
- 1 Worker = 1 エンジンインスタンス = 1 WASMインスタンス化。**プールは複数Worker**で構成する（§4）。

### 3. オプション正規化層

共通 `CompressionOptions` を各エンジン固有引数へ変換するアダプタを設ける。**完全共通化はしない**（ADR-002 Negative）。

```ts
interface EngineOptionMapper<TArgs> {
  /** presetを数値へ展開しつつエンジン固有引数を生成 */
  toEngineArgs(o: CompressionOptions): TArgs;
}
```

プリセット既定値（**第3回実測 docs/benchmark/RESULTS.md に基づき改訂**）:

| preset | DPI | 用途 | スキャン実測目安 |
|---|---:|---|---|
| max（最小サイズ） | 72 | 積極圧縮 | ~86%削減, SSIM≈0.89–0.90 |
| balanced（既定） | 100 | サイズ/画質両立 | ~76%削減, SSIM≈0.95 |
| quality | 150 | 画質優先/構造維持 | ~20%(再エンコードのみ), SSIM≈1.0 |

- **DPIが主レバー**。**quality は `-dJPEGQ` では無効、QFactor（setdistillerparams の ColorImageDict/GrayImageDict）で有効**（実測 RESULTS.md 第4回）。マニュアルモードで quality を QFactor 経由で公開する（quality 1..100 → QFactor 3.0..0.1）。
- **SSIM≥0.90 の閾値はコンテンツ依存**（scan-colorは72dpi+q80で0.90、写真は150dpi+q60で0.91）→ コンテンツ別に既定DPI/qualityを変える余地。次段のルーティング実証で確定。
- 旧 screen/ebook/printer は Ghostscript の PDFSETTINGS 名。UI プリセットは上記 max/balanced/quality に統一する。

#### 画像エンコードの必須設定（実測 RESULTS.md 第4回）

- **`-dPassThroughJPEGImages=false` を常時指定**。既定(true)は既存JPEGを素通しし圧縮が効かない。false化で同一DPIでも削減が倍増（scan 20%→50%, photo 20%→60%）。
- カラー/グレー: `AutoFilter*=false` + `*ImageFilter=/DCTEncode` + QFactor で quality 制御。
- **2値(mono): `/CCITTFaxEncode`**（DCT化は肥大）。ただし画像が mono と分類されない場合があり、**画像タイプ判別＝コンテンツ別ルーティングが必要**（次段）。
- 非JPEG: Flate は可逆でquality無し・肥大しがち、JPXEncode はビルド非対応。→ quality は DCT+QFactor で実装。
- どのエンジン/設定でも **肥大化ガード**（出力≥入力なら元を採用, ADR-007）を最終段に置く。

- **Ghostscript**: preset→`-dPDFSETTINGS=/screen|/ebook|...`、dpi→`-dColorImageResolution/-dGrayImageResolution/-dMonoImageResolution`＋`-dDownsample*Images=true`、colorMode=grayscale→`-sColorConversionStrategy=Gray`、jpegQuality→JPEGエンコード品質、常時`-dSAFER`。metadata除去はベストエフォート。
- **pdfcpu**: `optimize`＋画像リサンプル/置換。任意DPI・JPEG qualityの直接指定は追加実装が要る（ADR-002）。マッピングはエンジン確定後に詳細化。

### 4. Explorer と Worker プール（メモリ律速）

```ts
interface ExploreCandidate { id: string; options: CompressionOptions; }
interface ExploreResult {
  candidateId: string; options: CompressionOptions;
  result?: CompressResult; error?: string;
}
interface ExploreProgress {
  total: number; completed: number; running: number;
  results: ExploreResult[];
}
interface Explorer {
  run(
    input: Uint8Array | Blob,
    candidates: ExploreCandidate[],
    opts: { concurrency?: number; signal?: AbortSignal; onProgress?: (p: ExploreProgress) => void }
  ): Promise<ExploreResult[]>;
}
```

**プールサイズ算出（メモリを主制約）**:

```text
WASM_BASELINE   = 約20MB（16MBバイナリ＋ランタイム）
PEAK_FACTOR     = 6（入力に対する作業メモリ上限。ADR-005の保守値）
SAFE_FRACTION   = 0.5（端末メモリの安全利用率）

perWorkerBytes  = WASM_BASELINE + inputBytes * PEAK_FACTOR
deviceMemGB     = navigator.deviceMemory ?? (isMobile ? 2 : 4)
maxByMem        = floor(deviceMemGB*1e9 * SAFE_FRACTION / perWorkerBytes)
maxByCpu        = clamp((navigator.hardwareConcurrency ?? 2) - 1, 1, 4)
poolSize        = clamp(min(maxByMem, maxByCpu), 1, isMobile ? 1 : 4)
```

- **既定**: デスクトップは2から開始、モバイルは1（逐次寄り）。大きな入力では `maxByMem` が効き自動的に1へ収束。
- **メモリ逼迫バックオフ**: ジョブがOOM/失敗なら poolSize を段階的に1へ下げ、失敗ジョブを再投入。
  - **実測反映（RESULTS.md 第6回）**: `performance.measureUserAgentSpecificMemory()` は cross-origin isolation 必須で、COI 非導入（ADR-004）の本構成では**使用不可**（実ブラウザで確認）。よって主シグナルは**失敗検知ベース**とし、補助に WASM 線形メモリ `buffer.byteLength` を用いる。またGSの作業メモリは入力に線形でなく**固定 ~64–80MB が支配的**だったため、`perWorkerBytes` の入力線形モデルは小入力で過小評価する。プール予算は「**固定 ~80–100MB/worker + 大入力での増分**」に改める。
- **候補数上限**: 既定 **最大8候補**（ADR-001の上限方針）。まず代表プリセットを比較→最良近傍を絞り込む二段階。ユーザーは上限を引き上げ可能（端末性能に応じ警告）。

### 5. キャンセル・進捗・キャッシュ

- **キャンセル**: ジョブ毎に `AbortController`、探索全体に group signal。Ghostscript の `callMain()` は途中中断できないため、**Worker を `terminate()` して確実に中断**し、必要なら新規Workerを補充する。
- **進捗集約**: 各ジョブの `onProgress` を Explorer が集約し `ExploreProgress` としてUI（比較UI: ADR-007）へ通知。
- **重複排除/キャッシュ**: キー = `hash(input)`（SubtleCrypto）＋正規化オプションのJSON。同一キーは再計算せずキャッシュ結果を返す。

### 6. Explorer はエンジン非依存

```text
Explorer(pool, limits)
  └─ 各candidate.options
       └─ CompressionEngine.compress(input, options, {onProgress, signal})
            └─ ExploreResult { size, duration, options, blob, warnings } → 比較UI
```

## 残タスク（Accepted後の実装詳細）

- `PEAK_FACTOR` / `SAFE_FRACTION` / 既定poolSize / 候補上限の**実測チューニング**（ADR-005ベンチと連動）。
- pdfcpu の `EngineOptionMapper` 具体マッピング（エンジン確定後）。
- `measureUserAgentSpecificMemory()` は COI 必須で使用不可（RESULTS.md 第6回で確定）→ 失敗検知ベース＋線形メモリ byteLength でのバックオフを実装する。
- **UIフレームワーク／状態管理の選定は本ADRの範囲外**（別途決定。ビルドはVite+TypeScript、Worker RPCはComlinkを推奨）。

## Consequences

### Positive
- 進捗・キャンセル・メモリ制御をUXとエンジンで一貫して扱える契約が確定。
- 並列度をメモリ律速で自動調整し、モバイルOOMを予防（ADR-005と整合）。
- エンジン交換可能性（ADR-002）を維持。

### Negative
- Worker毎にWASMを再インスタンス化するため、並列時のメモリ・初期化コストが大きい（プール小さめが既定）。
- キャンセルがWorker終了に依存し、補充コストが発生。

## Revisit Conditions
- 採用エンジン確定時（正規化マッピング・`estimatedPeakMemoryBytes`精度の確定）。
- ベンチマークで並列度・メモリ係数が実測確定した時。
- thread版WASM採用時（プール前提が変わる。ADR-004と連動）。
