/**
 * pdfcpu WASM エンジンアダプタ (Node計測用・第二候補 / ADR-002)。
 *
 * pdfcpu の `optimize` は構造最適化 (相互参照/重複オブジェクトの整理等) が主で、
 * 画像のダウンサンプリング/再圧縮は既定では行わない (ADR-002 の指摘通り)。
 * したがってスキャン/画像PDFでは削減が小さく出るはず、という比較仮説を実測する。
 *
 * gs-engine.mjs と同一の compress() インターフェースを提供し、同条件比較に用いる。
 * ラッパー(pdfcpu-wasm)は MIT、pdfcpu 本体は Apache-2.0。
 *
 * Node 24 の fetch 経由 wasm ロードは失敗するため、事前コンパイルした Module を
 * インスタンスの `wasm` フィールドへ注入して回避する。
 * WASI preopen: 入力は bare 名 (`in.pdf`)、出力は `/output/` 配下に書く。
 */
import { Pdfcpu } from "pdfcpu-wasm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve("pdfcpu-wasm/pdfcpu.wasm");
export const WASM_BYTES = readFileSync(WASM_PATH).length; // 約30MB

let wasmModule = null;
async function getModule() {
  if (!wasmModule) wasmModule = await WebAssembly.compile(readFileSync(WASM_PATH));
  return wasmModule;
}

/**
 * 1 ファイルを最適化する。options は現状 { mode:'optimize' } のみ対応。
 * pdfcpu には gs のような DPI/quality ノブが無いため preset は無視する。
 */
export async function compress(inputBytes, _options = {}) {
  const t0 = performance.now();
  const mod = await getModule();
  const p = new Pdfcpu();
  p.wasm = mod;
  const tInit = performance.now();

  const inFile = new File([new Uint8Array(inputBytes)], "in.pdf");
  let out = null;
  let exitCode = 0;
  try {
    const handle = await p.run(["optimize", "in.pdf", "/output/out.pdf"], [inFile]);
    const f = await handle.readFile("out.pdf");
    if (f) out = Buffer.from(await f.arrayBuffer());
  } catch (e) {
    exitCode = 1;
    out = null;
  }
  const tDone = performance.now();
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
    args: ["optimize", "in.pdf", "/output/out.pdf"],
  };
}

export const engineInfo = {
  id: "pdfcpu-wasm",
  package: "pdfcpu-wasm",
  license: "Apache-2.0 (wrapper MIT)",
  wasmBytes: WASM_BYTES,
};

/** pdfcpu は optimize の単一条件で比較する */
export const conditions = [{ label: "optimize", options: { mode: "optimize" } }];

export const id = engineInfo.id;
