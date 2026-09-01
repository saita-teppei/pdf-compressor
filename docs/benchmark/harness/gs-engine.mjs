/**
 * Ghostscript WASM エンジンアダプタ (Node計測用)。
 *
 * ADR-008 の CompressionEngine 契約を Node 上で実装した計測アダプタ。
 * 本番のブラウザ Web Worker 版は別途実装するが、圧縮結果(削減率・品質)は
 * エンジン決定なので、まず Node で実測して ADR-002/005 の判断材料を得る。
 *
 * 注意:
 * - @jspawn/ghostscript-wasm は AGPL-3.0 (ADR-003 で許容)。
 * - Node 24 はグローバル fetch を持つため gs.js のロードが streaming 分岐に入り
 *   失敗する。instantiateWasm フックで wasmBinary から直接インスタンス化して回避。
 * - Ghostscript のグローバル状態汚染を避けるため、compress ごとに新規モジュールを
 *   生成する (init は実測 ~20ms と安価)。これは ADR-008「1 Worker = 1 インスタンス」
 *   の Node 版近似。
 */
import gs from "@jspawn/ghostscript-wasm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WASM_BINARY = readFileSync(require.resolve("@jspawn/ghostscript-wasm/gs.wasm"));

export const WASM_BYTES = WASM_BINARY.length; // ADR-004 検証用 (約16MB)

/**
 * データ準拠プリセット (docs/benchmark/RESULTS.md 第3回)。DPI が唯一の実効レバー。
 * max=最小サイズ / balanced=既定 / quality=画質優先。
 */
const PRESET_DPI = { max: 72, balanced: 100, quality: 150 };

/**
 * jpegQuality(1..100) → Ghostscript QFactor。
 * 実測(RESULTS.md 第4回)で `-dJPEGQ` は無効、QFactor(setdistillerparams)は有効。
 * 高quality→低QFactor(高画質/大)、低quality→高QFactor(低画質/小)。
 */
function qualityToQFactor(q) {
  const qf = (100 - q) / 30; // q90→0.33, q75→0.83, q60→1.33, q40→2.0
  return Math.min(3.0, Math.max(0.1, Math.round(qf * 100) / 100));
}

/**
 * 共通 CompressionOptions を Ghostscript 引数へ正規化する (ADR-008 §3)。
 * options: { preset?, dpi?, jpegQuality?, colorMode?, stripMetadata? }
 * 返り値: { flags: string[], distiller: string|null } (出力/入力は compress 側で付与)
 *
 * 重要: pdfwrite の既定 PassThroughJPEGImages=true は既存JPEGを再エンコードせず素通し
 * するため圧縮が効かない。実測(RESULTS.md 第4回)で false 化により同一DPIでも
 * 削減が倍増したため、常に false にして再エンコードさせる。
 */
export function toGsArgs(options = {}) {
  const flags = [
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-dQUIET",
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    // 既存JPEGを再エンコードさせる (本命の圧縮スイッチ)
    "-dPassThroughJPEGImages=false",
    "-dAutoFilterColorImages=false",
    "-dAutoFilterGrayImages=false",
    "-dEncodeColorImages=true",
    "-dEncodeGrayImages=true",
    "-dColorImageFilter=/DCTEncode",
    "-dGrayImageFilter=/DCTEncode",
    // 2値(mono)画像は JPEG でなく CCITTFax。DCT化するとむしろ肥大するため型別に扱う
    // (実測 RESULTS.md 第4回。コンテンツ別ルーティングの必要性を裏付け)。
    "-dEncodeMonoImages=true",
    "-dMonoImageFilter=/CCITTFaxEncode",
    "-dMonoImageDownsampleType=/Subsample",
  ];

  // DPI: preset→DPI へ写像、または明示 dpi。Threshold=1.0/Bicubic で確実に再サンプル。
  const dpi = options.dpi ?? (options.preset ? PRESET_DPI[options.preset] : null);
  if (dpi) {
    flags.push(
      "-dDownsampleColorImages=true",
      "-dDownsampleGrayImages=true",
      "-dDownsampleMonoImages=true",
      `-dColorImageResolution=${dpi}`,
      `-dGrayImageResolution=${dpi}`,
      `-dMonoImageResolution=${dpi}`,
      "-dColorImageDownsampleThreshold=1.0",
      "-dGrayImageDownsampleThreshold=1.0",
      "-dMonoImageDownsampleThreshold=1.0",
      "-dColorImageDownsampleType=/Bicubic",
      "-dGrayImageDownsampleType=/Bicubic",
    );
  }

  // カラーモード
  if (options.colorMode === "grayscale" || options.colorMode === "monochrome") {
    flags.push("-sColorConversionStrategy=Gray", "-dProcessColorModel=/DeviceGray");
  }

  // quality → QFactor は setdistillerparams(-c) で渡す
  let distiller = null;
  if (options.jpegQuality) {
    const qf = qualityToQFactor(options.jpegQuality);
    const dict = `<< /QFactor ${qf} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
    distiller = `<< /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams`;
  }

  // stripMetadata: Ghostscript では確実な XMP 除去が難しくベストエフォート (ADR-006)。今後 pdfmark 検討。
  return { flags, distiller };
}

async function newModule() {
  return gs({
    noInitialRun: true,
    print() {},
    printErr() {},
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(WASM_BINARY, imports).then((r) => receive(r.instance));
      return {};
    },
  });
}

/**
 * 1 ファイルを圧縮する。
 * @param {Uint8Array|Buffer} inputBytes
 * @param {object} options CompressionOptions
 * @returns {Promise<{blob:Buffer,inputBytes:number,outputBytes:number,
 *   reductionRatio:number,initMs:number,compressMs:number,exitCode:number,
 *   valid:boolean,args:string[]}>}
 */
export async function compress(inputBytes, options = {}) {
  const { flags, distiller } = toGsArgs(options);
  // 引数順: フラグ → 出力 → (-c 蒸留パラメータ) → -f 入力
  const args = [...flags, "-sOutputFile=/out.pdf"];
  if (distiller) args.push("-c", distiller, "-f", "/in.pdf");
  else args.push("/in.pdf");

  const t0 = performance.now();
  const mod = await newModule();
  const tInit = performance.now();

  mod.FS.writeFile("/in.pdf", inputBytes);
  const exitCode = mod.callMain(args);
  const tDone = performance.now();

  let out = null;
  try {
    out = Buffer.from(mod.FS.readFile("/out.pdf"));
  } catch {
    out = null;
  }
  const valid = !!out && out.length > 4 && out.slice(0, 5).toString() === "%PDF-";

  return {
    blob: out,
    inputBytes: inputBytes.length,
    outputBytes: out ? out.length : 0,
    reductionRatio: out ? 1 - out.length / inputBytes.length : 0,
    initMs: tInit - t0,
    compressMs: tDone - tInit,
    exitCode,
    valid,
    args,
  };
}

export const engineInfo = {
  id: "ghostscript-wasm",
  package: "@jspawn/ghostscript-wasm",
  license: "AGPL-3.0",
  wasmBytes: WASM_BYTES,
};

/** 同条件比較で回す条件セット (ADR-008 データ準拠プリセット) */
export const conditions = [
  { label: "max", options: { preset: "max" } },
  { label: "balanced", options: { preset: "balanced" } },
  { label: "quality", options: { preset: "quality" } },
];

export const id = engineInfo.id;
