/**
 * ADR-008 の CompressionEngine 契約のうち、本 PoC で用いる最小サブセットを TS 化したもの。
 * 本番アプリはここを起点に inspect()/PdfFeatureFlags/AbortSignal 等へ拡張する（PoC 範囲外）。
 */

export type EngineId = "ghostscript-wasm" | "pdfcpu-wasm";
export type PresetName = "max" | "balanced" | "quality";
export type ColorMode = "color" | "grayscale" | "monochrome";

/** UI/Explorer が扱う正規化済みオプション（エンジン非依存, ADR-008 §1） */
export interface CompressionOptions {
  preset?: PresetName;
  dpi?: number;
  jpegQuality?: number;
  colorMode?: ColorMode;
  stripMetadata?: boolean;
}

/** WASM ロード結果（初期ロード NFR 検証用, ADR-004/005） */
export interface LoadResult {
  engineId: EngineId;
  wasmBytes: number;
  /** 自前 fetch でのロード時間(ms)。IndexedDB ヒット時は温状態 */
  loadMs: number;
  fromCache: boolean;
  /** WebAssembly.compile 時間(ms) */
  compileMs: number;
}

/** 1 圧縮の計測結果（ADR-008 CompressResult のブラウザ計測版） */
export interface CompressMetrics {
  engineId: EngineId;
  inputBytes: number;
  outputBytes: number;
  reductionRatio: number;
  /** インスタンス化(ms)。GS は module→instance、pdfcpu は instantiate 込み */
  initMs: number;
  /** 実圧縮(ms)。GS callMain / pdfcpu run */
  compressMs: number;
  /**
   * WASM 線形メモリのサイズ(bytes)。圧縮後の buffer.byteLength を採る。
   * 線形メモリは伸長のみのためピーク作業メモリの代理値になる（ADR-005/008 PEAK_FACTOR 検証）。
   * pdfcpu はインスタンスを外部公開しないため null。
   */
  wasmHeapBytes: number | null;
  exitCode: number;
  valid: boolean;
}

/** compress の返り値。出力バイト列は Transferable で受け渡す */
export interface CompressResult {
  metrics: CompressMetrics;
  output: Uint8Array;
}

export interface BrowserEngine {
  readonly id: EngineId;
  /** wasm を取得・コンパイルして準備する（初回ロード計測もここ） */
  load(): Promise<LoadResult>;
  compress(input: Uint8Array, options: CompressionOptions): Promise<CompressResult>;
}
