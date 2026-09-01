/**
 * 圧縮 Worker（ADR-008 §2）。1 Worker = 1 エンジンインスタンス群。
 * メインへ Comlink で Promise ベース RPC を公開。入力/出力は Transferable(ArrayBuffer)。
 *
 * compressSmart: inspect（pdfcpu で種別判定, ADR-010）→ 候補順に圧縮 →
 * 「有効かつ入力未満」の最初を採用（無ければ passthrough）。誤分類・肥大化でも出力は入力を超えない。
 */
import * as Comlink from "comlink";
import { GsEngine } from "../engines/gs-engine";
import { PdfcpuEngine } from "../engines/pdfcpu-engine";
import type { CompressionOptions, EngineId } from "../engines/engine-contract";
import {
  classify,
  parseImagesList,
  parseInfoJson,
  planCandidates,
  type CandidateEngine,
  type CompressProgress,
  type InspectResult,
  type SmartCompressResult,
} from "../routing/inspect";

const engines = {
  "ghostscript-wasm": new GsEngine(),
  "pdfcpu-wasm": new PdfcpuEngine(),
};

/** pdfcpu の info/images を実行して種別判定する（ADR-010 の inspect） */
async function runInspect(bytes: Uint8Array): Promise<{ inspect: InspectResult; inspectMs: number }> {
  const t0 = performance.now();
  const info = await engines["pdfcpu-wasm"].runCommand(["info", "-j", "in.pdf"], bytes);
  const imgs = await engines["pdfcpu-wasm"].runCommand(["images", "list", "in.pdf"], bytes);
  const { pageCount, pageWidthPt, features } = parseInfoJson(info.stdout);
  const images = parseImagesList(imgs.stdout);
  const inspect = classify(pageCount, pageWidthPt, images, features);
  return { inspect, inspectMs: performance.now() - t0 };
}

const api = {
  async load(id: EngineId) {
    return engines[id].load();
  },

  async compress(id: EngineId, input: ArrayBuffer, options: CompressionOptions) {
    const res = await engines[id].compress(new Uint8Array(input), options);
    return Comlink.transfer(res, [res.output.buffer]);
  },

  /** 圧縮せず種別判定のみ（M4 の機能保全提示などに使用） */
  async inspect(input: ArrayBuffer): Promise<InspectResult> {
    const { inspect } = await runInspect(new Uint8Array(input));
    return inspect;
  },

  /**
   * コンテンツ別ルーティング＋ガード＋フォールバックで圧縮する（ADR-010）。
   * override.preset を渡すと GS の preset を固定できる（マニュアルモード/M4 の足場）。
   */
  async compressSmart(
    input: ArrayBuffer,
    override?: CompressionOptions,
    onProgress?: (p: CompressProgress) => void,
  ): Promise<SmartCompressResult> {
    const bytes = new Uint8Array(input);
    const inputBytes = bytes.length;
    onProgress?.({ phase: "inspecting" });
    const { inspect, inspectMs } = await runInspect(bytes);

    // 暗号化PDFは再生成できない（GS/pdfcpu が失敗する）。明示的に弾く（ADR-006）。
    if (inspect.features.encrypted) {
      throw new Error("ENCRYPTED_UNSUPPORTED");
    }

    const candidates = planCandidates(inspect, override);
    const engineCandidates = candidates.filter((c) => c.engine !== "passthrough");
    const tried: string[] = [];
    let chosenEngine: CandidateEngine = "passthrough";
    let chosenPreset: string | undefined;
    let output: Uint8Array = bytes;
    let outputBytes = inputBytes;
    let compressMs = 0;

    let attempt = 0;
    for (const cand of candidates) {
      if (cand.engine === "passthrough") break; // 既定値（元ファイル）を採用
      attempt++;
      onProgress?.({
        phase: "compressing",
        engine: cand.engine,
        preset: cand.options.preset,
        attempt,
        total: engineCandidates.length,
      });
      tried.push(cand.engine + (cand.options.preset ? ":" + cand.options.preset : ""));
      const res = await engines[cand.engine as EngineId].compress(bytes, cand.options);
      // 肥大化ガード（ADR-007）: 有効かつ入力未満のみ採用
      if (res.metrics.valid && res.metrics.outputBytes < inputBytes) {
        chosenEngine = cand.engine;
        chosenPreset = cand.options.preset;
        output = res.output;
        outputBytes = res.metrics.outputBytes;
        compressMs = res.metrics.compressMs;
        break;
      }
    }

    const result: SmartCompressResult = {
      kind: inspect.kind,
      inspect,
      chosenEngine,
      chosenPreset,
      inputBytes,
      outputBytes,
      reduction: inputBytes ? 1 - outputBytes / inputBytes : 0,
      compressMs,
      inspectMs,
      tried,
      output,
    };
    return Comlink.transfer(result, [output.buffer as ArrayBuffer]);
  },
};

export type CompressWorkerApi = typeof api;
Comlink.expose(api);
