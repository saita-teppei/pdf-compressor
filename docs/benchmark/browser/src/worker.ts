/**
 * 圧縮 Worker。ADR-008 §2 のとおり 1 Worker = 1 エンジンインスタンス群を保持し、
 * メインへ Comlink で Promise ベース RPC を公開する。入力/出力は Transferable(ArrayBuffer)。
 */
import * as Comlink from "comlink";
import { GsEngine } from "./gs-browser-engine";
import { PdfcpuEngine } from "./pdfcpu-browser-engine";
import type { CompressionOptions, EngineId } from "./engine-contract";

const engines = {
  "ghostscript-wasm": new GsEngine(),
  "pdfcpu-wasm": new PdfcpuEngine(),
};

const api = {
  /** ブラウザ機能検出（COI/メモリ計測 API 可否など。ADR-004/008 の論点1・2 検証） */
  selfCheck() {
    const perf = performance as any;
    return {
      crossOriginIsolated: (globalThis as any).crossOriginIsolated ?? false,
      hasMeasureUserAgentSpecificMemory: typeof perf.measureUserAgentSpecificMemory === "function",
      hasPerformanceMemory: !!perf.memory,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: (navigator as any).deviceMemory ?? null,
      userAgent: navigator.userAgent,
    };
  },

  async load(id: EngineId) {
    return engines[id].load();
  },

  async compress(id: EngineId, input: ArrayBuffer, options: CompressionOptions) {
    const res = await engines[id].compress(new Uint8Array(input), options);
    // 出力バッファを Transferable で返す
    return Comlink.transfer(res, [res.output.buffer]);
  },
};

export type WorkerApi = typeof api;
Comlink.expose(api);
