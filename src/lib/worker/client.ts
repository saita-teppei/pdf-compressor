/**
 * メインスレッド側の圧縮クライアント。Worker を生成し Comlink で包む。
 * ブラウザでのみ呼ぶこと（Worker は prerender/SSR には存在しない）。
 */
import * as Comlink from "comlink";
import type { CompressWorkerApi } from "./compress.worker";
import type { CompressionOptions, CompressResult, EngineId } from "../engines/engine-contract";
import type { CompressProgress, InspectResult, SmartCompressResult } from "../routing/inspect";

export interface Compressor {
  compress(id: EngineId, input: ArrayBuffer, options: CompressionOptions): Promise<CompressResult>;
  /** inspect→ルーティング→ガードで圧縮（ADR-010）。override で GS 設定を固定可。onProgress でフェーズ進捗を受け取れる。 */
  compressSmart(
    input: ArrayBuffer,
    override?: CompressionOptions,
    onProgress?: (p: CompressProgress) => void,
  ): Promise<SmartCompressResult>;
  /** 圧縮せず種別判定のみ */
  inspect(input: ArrayBuffer): Promise<InspectResult>;
  /** 実行中ジョブの確実な中断（GS callMain は中断不可のため terminate, ADR-008 §5） */
  terminate(): void;
}

export function createCompressor(): Compressor {
  const worker = new Worker(new URL("./compress.worker.ts", import.meta.url), { type: "module" });
  const api = Comlink.wrap<CompressWorkerApi>(worker);
  return {
    compress(id, input, options) {
      return api.compress(id, Comlink.transfer(input, [input]), options) as Promise<CompressResult>;
    },
    compressSmart(input, override, onProgress) {
      return api.compressSmart(
        Comlink.transfer(input, [input]),
        override,
        onProgress ? Comlink.proxy(onProgress) : undefined,
      ) as Promise<SmartCompressResult>;
    },
    inspect(input) {
      return api.inspect(Comlink.transfer(input, [input])) as Promise<InspectResult>;
    },
    terminate() {
      worker.terminate();
    },
  };
}
