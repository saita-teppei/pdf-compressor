/**
 * Ghostscript WASM エンジンのブラウザ(Web Worker)版アダプタ。
 *
 * docs/benchmark/harness/gs-engine.mjs (Node計測版) の圧縮ロジックを移植したもの。
 * 圧縮引数の組み立て(toGsArgs) は Node 版と同一に保ち、Node 実測(RESULTS.md)との
 * 等価性を検証できるようにする。差分はロード/インスタンス化の経路のみ:
 *  - Node: instantiateWasm フックで readFileSync したバイトから直接インスタンス化
 *  - Browser: wasm を自前 fetch(+IndexedDB キャッシュ)→ 事前 compile → 毎回 instantiate
 *
 * GS はグローバル状態を持つため、Node 版同様 compress ごとに新規 Module を生成する。
 */
// @ts-ignore 型定義の無いパッケージ
import createGs from "@jspawn/ghostscript-wasm";
// @ts-ignore ?url は Vite のアセット URL
import gsWasmUrl from "@jspawn/ghostscript-wasm/gs.wasm?url";
import type { BrowserEngine, CompressionOptions, CompressResult, LoadResult } from "./engine-contract";
import { loadWasmBytes } from "./idb-cache";

const PRESET_DPI: Record<string, number> = { max: 72, balanced: 100, quality: 150 };

/** jpegQuality(1..100) → Ghostscript QFactor（gs-engine.mjs と同一式）。 */
function qualityToQFactor(q: number): number {
  const qf = (100 - q) / 30;
  return Math.min(3.0, Math.max(0.1, Math.round(qf * 100) / 100));
}

/**
 * 共通 CompressionOptions を Ghostscript 引数へ正規化する（gs-engine.mjs の toGsArgs 移植）。
 * PassThroughJPEGImages=false / DCTEncode+QFactor / mono=CCITTFax は実測(RESULTS.md 第4回)に基づく必須設定。
 */
export function toGsArgs(options: CompressionOptions = {}): { flags: string[]; distiller: string | null } {
  const flags = [
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-dQUIET",
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPassThroughJPEGImages=false",
    "-dAutoFilterColorImages=false",
    "-dAutoFilterGrayImages=false",
    "-dEncodeColorImages=true",
    "-dEncodeGrayImages=true",
    "-dColorImageFilter=/DCTEncode",
    "-dGrayImageFilter=/DCTEncode",
    "-dEncodeMonoImages=true",
    "-dMonoImageFilter=/CCITTFaxEncode",
    "-dMonoImageDownsampleType=/Subsample",
  ];

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

  if (options.colorMode === "grayscale" || options.colorMode === "monochrome") {
    flags.push("-sColorConversionStrategy=Gray", "-dProcessColorModel=/DeviceGray");
  }

  let distiller: string | null = null;
  if (options.jpegQuality) {
    const qf = qualityToQFactor(options.jpegQuality);
    const dict = `<< /QFactor ${qf} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
    distiller = `<< /ColorImageDict ${dict} /GrayImageDict ${dict} >> setdistillerparams`;
  }

  return { flags, distiller };
}

export class GsEngine implements BrowserEngine {
  readonly id = "ghostscript-wasm" as const;
  private module: WebAssembly.Module | null = null;
  private wasmBytes = 0;

  async load(): Promise<LoadResult> {
    const { bytes, loadMs, fromCache } = await loadWasmBytes("ghostscript-wasm", gsWasmUrl);
    this.wasmBytes = bytes.byteLength;
    const t0 = performance.now();
    this.module = await WebAssembly.compile(bytes);
    const compileMs = performance.now() - t0;
    return { engineId: this.id, wasmBytes: this.wasmBytes, loadMs, fromCache, compileMs };
  }

  private async newModule(): Promise<any> {
    const compiled = this.module!;
    return createGs({
      noInitialRun: true,
      print() {},
      printErr() {},
      // 事前 compile した Module を毎回 instantiate（fetch/streaming 分岐を完全に回避）。
      instantiateWasm(imports: WebAssembly.Imports, receive: (inst: WebAssembly.Instance) => void) {
        WebAssembly.instantiate(compiled, imports).then((inst) => receive(inst));
        return {};
      },
    });
  }

  async compress(input: Uint8Array, options: CompressionOptions = {}): Promise<CompressResult> {
    if (!this.module) await this.load();
    const { flags, distiller } = toGsArgs(options);
    const args = [...flags, "-sOutputFile=/out.pdf"];
    if (distiller) args.push("-c", distiller, "-f", "/in.pdf");
    else args.push("/in.pdf");

    const t0 = performance.now();
    const mod = await this.newModule();
    const tInit = performance.now();

    mod.FS.writeFile("/in.pdf", input);
    const exitCode: number = mod.callMain(args);
    const tDone = performance.now();

    let out: Uint8Array | null = null;
    try {
      out = mod.FS.readFile("/out.pdf") as Uint8Array;
    } catch {
      out = null;
    }
    const buf: ArrayBuffer = (mod.HEAPU8?.buffer ?? mod.wasmMemory?.buffer) as ArrayBuffer;
    const wasmHeapBytes = buf ? buf.byteLength : null;

    const output = out ? new Uint8Array(out) : new Uint8Array(0); // FS ビューから独立コピー
    const valid = output.length > 4 && String.fromCharCode(...output.slice(0, 5)) === "%PDF-";

    return {
      output,
      metrics: {
        engineId: this.id,
        inputBytes: input.length,
        outputBytes: output.length,
        reductionRatio: output.length ? 1 - output.length / input.length : 0,
        initMs: tInit - t0,
        compressMs: tDone - tInit,
        wasmHeapBytes,
        exitCode,
        valid,
      },
    };
  }
}
