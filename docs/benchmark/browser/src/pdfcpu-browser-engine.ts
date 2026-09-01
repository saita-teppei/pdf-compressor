/**
 * pdfcpu WASM エンジンのブラウザ(Web Worker)版アダプタ（第二候補 / ADR-002）。
 *
 * docs/benchmark/harness/pdfcpu-engine.mjs の移植。pdfcpu-wasm は元々ブラウザ向け
 * WASI シムで、既定では compileStreaming(fetch(...)) を使う。ここでは Node 版と同様に
 * 自前 fetch(+IndexedDB)→事前 compile した Module を p.wasm に注入し、ロード計測とキャッシュを制御する。
 *
 * pdfcpu は optimize（構造最適化）が主で画像ダウンサンプリングは行わない。DPI/quality ノブは
 * 持たないため options は無視し、preset は結果のラベル付けにのみ用いる（Node 版と同一）。
 */
// @ts-ignore 型は types/index.d.ts にあるが実体 index.js を使う
import { Pdfcpu } from "pdfcpu-wasm";
// @ts-ignore ?url は Vite のアセット URL
import pdfcpuWasmUrl from "pdfcpu-wasm/pdfcpu.wasm?url";
import type { BrowserEngine, CompressionOptions, CompressResult, LoadResult } from "./engine-contract";
import { loadWasmBytes } from "./idb-cache";

export class PdfcpuEngine implements BrowserEngine {
  readonly id = "pdfcpu-wasm" as const;
  private module: WebAssembly.Module | null = null;
  private wasmBytes = 0;

  async load(): Promise<LoadResult> {
    const { bytes, loadMs, fromCache } = await loadWasmBytes("pdfcpu-wasm", pdfcpuWasmUrl);
    this.wasmBytes = bytes.byteLength;
    const t0 = performance.now();
    this.module = await WebAssembly.compile(bytes);
    const compileMs = performance.now() - t0;
    return { engineId: this.id, wasmBytes: this.wasmBytes, loadMs, fromCache, compileMs };
  }

  async compress(input: Uint8Array, _options: CompressionOptions = {}): Promise<CompressResult> {
    if (!this.module) await this.load();
    const t0 = performance.now();
    const p: any = new Pdfcpu();
    p.wasm = this.module; // 事前 compile 済み Module を注入（既定の compileStreaming を回避）
    const tInit = performance.now();

    let out: Uint8Array | null = null;
    let exitCode = 0;
    try {
      const inFile = new File([input.slice()], "in.pdf");
      const handle = await p.run(["optimize", "in.pdf", "/output/out.pdf"], [inFile]);
      const f = await handle.readFile("out.pdf");
      if (f) out = new Uint8Array(await f.arrayBuffer());
    } catch {
      exitCode = 1;
      out = null;
    }
    const tDone = performance.now();

    const output = out ?? new Uint8Array(0);
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
        wasmHeapBytes: null, // シムがインスタンスを外部公開しないため取得不可
        exitCode,
        valid,
      },
    };
  }
}
