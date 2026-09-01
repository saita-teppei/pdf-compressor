/**
 * 計測ハーネスのメインスクリプト。Playwright から呼び出す API を window.__bench に公開する。
 * - 通常の圧縮スループット計測は常設 Worker(default) を使う（GS は module を保持し compile を再利用）。
 * - ロード計測(cold/warm) は都度新規 Worker を立ててエンジンを未初期化状態から測る。
 * - キャンセルは Worker.terminate() で行う（ADR-008 §5。GS callMain は中断不可のため確実中断）。
 */
import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";
import type { CompressionOptions, EngineId } from "./engine-contract";
import { idbClear } from "./idb-cache";

function newWorker(): { raw: Worker; api: Comlink.Remote<WorkerApi> } {
  const raw = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return { raw, api: Comlink.wrap<WorkerApi>(raw) };
}

const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
};

let def = newWorker();

const bench = {
  async selfCheck() {
    return def.api.selfCheck();
  },

  async clearCache() {
    await idbClear();
  },

  /** 未初期化 Worker から load を計測して返す（cold/warm は事前の clearCache で制御） */
  async freshLoad(id: EngineId) {
    const w = newWorker();
    try {
      return await w.api.load(id);
    } finally {
      w.raw.terminate();
    }
  },

  /** 常設 Worker で 1 圧縮。入力/出力は base64 で受け渡す */
  async compress(id: EngineId, inputB64: string, options: CompressionOptions) {
    const input = b64ToBytes(inputB64);
    const buf = input.buffer;
    const res = await def.api.compress(id, Comlink.transfer(buf, [buf]), options);
    return { metrics: res.metrics, outputB64: bytesToB64(res.output) };
  },

  /**
   * キャンセル検証: 専用 Worker で GS 圧縮を開始し、待たずに terminate() する。
   * 中断が効けば元 Promise は解決しない → タイムアウトで判定。その後、新規 Worker で
   * 復旧して素早く 1 圧縮できることを確認する（ADR-008 §5 の Worker 補充）。
   */
  async cancelTest(inputB64: string, options: CompressionOptions, killAfterMs = 40) {
    const input = b64ToBytes(inputB64);
    const w = newWorker();
    const buf = input.buffer;
    let resolved = false;
    const p = w.api
      .compress("ghostscript-wasm", Comlink.transfer(buf, [buf]), options)
      .then(() => {
        resolved = true;
      })
      .catch(() => {
        resolved = true;
      });
    void p;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, killAfterMs));
    w.raw.terminate();
    const terminateAtMs = performance.now() - t0;
    // terminate 後に解決しないことを確認する猶予
    await new Promise((r) => setTimeout(r, 400));
    return { resolvedAfterTerminate: resolved, terminateAtMs };
  },

  /** 復旧確認: 新規 Worker を立てて小さな圧縮が通ることを確認する */
  async recoverCheck(inputB64: string, options: CompressionOptions) {
    const w = newWorker();
    try {
      const input = b64ToBytes(inputB64);
      const buf = input.buffer;
      const res = await w.api.compress("ghostscript-wasm", Comlink.transfer(buf, [buf]), options);
      return { valid: res.metrics.valid, compressMs: res.metrics.compressMs };
    } finally {
      w.raw.terminate();
    }
  },
};

export type Bench = typeof bench;
(window as any).__bench = bench;
(window as any).__benchReady = true;
log("bench ready");
