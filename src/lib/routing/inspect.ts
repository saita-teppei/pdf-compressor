/**
 * コンテンツ別ルーティングのための inspect（ADR-010）。
 *
 * 別途エンジン(pdfcpu)を持っているため、pdfcpu の CLI を使って特徴抽出する:
 *  - `info -j in.pdf`     : pageCount / pageSize / 文書レベルフラグ(tagged/form/signatures) を JSON で取得
 *  - `images list in.pdf` : 画像ごとの Page/Width/Height/ColorSpace/Comp/bpc/Filters を表形式で取得
 *
 * 本モジュールは **純粋なパーサ＋分類器＋ルーティング** のみ（pdfcpu 実行は Worker 側）。
 * 版差でCLI書式が変わりうるため防御的にパースする。分類が甘くても、ガード＋フォールバック
 * （planCandidates + Worker のガード）で「出力は入力を超えない」ことは保証される。
 */

import type { CompressionOptions, EngineId } from "../engines/engine-contract";

export type ContentKind = "scan-color" | "scan-gray" | "scan-bitonal" | "mixed" | "text";

export interface ImageInfo {
  page: number;
  width: number;
  height: number;
  colorSpace: string;
  components: number;
  bpc: number;
  filters: string;
}

/** ADR-006 の事前明示に使う文書レベルフラグ（取得できた範囲） */
export interface PdfFeatureFlags {
  tagged: boolean;
  form: boolean;
  signatures: boolean;
  encrypted: boolean;
}

export interface InspectResult {
  pageCount: number;
  kind: ContentKind;
  imageCount: number;
  imagePages: number;
  imageCoverage: number; // imagePages / pageCount（0..1）
  anyColor: boolean;
  bitonal: boolean;
  /** 埋め込み画像の実効解像度(dpi)。最大画像の幅px ÷ ページ幅inch。不明なら 0。 */
  effectiveDpi: number;
  features: PdfFeatureFlags;
}

/** info -j の stdout（先頭に "installing user font" 等の雑音が付く）から必要値を取り出す */
export function parseInfoJson(stdout: string): {
  pageCount: number;
  pageWidthPt: number;
  features: PdfFeatureFlags;
} {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  let pageCount = 0;
  let pageWidthPt = 0;
  const features: PdfFeatureFlags = { tagged: false, form: false, signatures: false, encrypted: false };
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(stdout.slice(start, end + 1));
      const info = j?.infos?.[0] ?? {};
      pageCount = Number(info.pageCount) || 0;
      pageWidthPt = Number(info?.pageSizes?.[0]?.width) || 0;
      features.tagged = !!info.tagged;
      features.form = !!info.form;
      features.signatures = !!info.signatures;
      features.encrypted = !!(info.encrypted ?? info.encryption);
    } catch {
      /* JSON でなければ既定のまま */
    }
  }
  return { pageCount, pageWidthPt, features };
}

/** `images list` の表を行ごとにパースする */
export function parseImagesList(stdout: string): ImageInfo[] {
  const images: ImageInfo[] = [];
  for (const line of stdout.split("\n")) {
    // データ行は「数字 │ …」で始まる。区切り(━)やヘッダは除外される。
    if (!/^\s*\d+\s*│/.test(line)) continue;
    const cells = line.split("│").map((c) => c.trim());
    // 期待列: [Page, Obj#, Id, Type…, Width, Height, "ColorSpace Comp bpc [Interp]", Size, Filters]
    if (cells.length < 8) continue;
    const page = parseInt(cells[0], 10);
    if (Number.isNaN(page)) continue;
    const width = parseInt(cells[4], 10) || 0;
    const height = parseInt(cells[5], 10) || 0;
    const csTokens = cells[6].split(/\s+/).filter(Boolean);
    const colorSpace = csTokens[0] ?? "";
    const components = parseInt(csTokens[1] ?? "0", 10) || 0;
    const bpc = parseInt(csTokens[2] ?? "0", 10) || 0;
    const filters = cells[cells.length - 1] ?? "";
    images.push({ page, width, height, colorSpace, components, bpc, filters });
  }
  return images;
}

/** info + images の解析結果から種別と実効DPIを判定する */
export function classify(
  pageCount: number,
  pageWidthPt: number,
  images: ImageInfo[],
  features: PdfFeatureFlags,
): InspectResult {
  const imageCount = images.length;
  const imagePages = new Set(images.map((i) => i.page)).size;
  const imageCoverage = pageCount > 0 ? imagePages / pageCount : 0;
  const anyColor = images.some((i) => i.components >= 3);
  const bitonal = imageCount > 0 && images.every((i) => i.bpc === 1);

  // 実効DPI: 最大画像幅px ÷ ページ幅inch（ページ幅pt/72）。ダウンサンプル要否の判断に使う。
  const pageWidthIn = pageWidthPt > 0 ? pageWidthPt / 72 : 0;
  const maxImgWidth = images.reduce((m, i) => Math.max(m, i.width), 0);
  const effectiveDpi = pageWidthIn > 0 && maxImgWidth > 0 ? Math.round(maxImgWidth / pageWidthIn) : 0;

  let kind: ContentKind;
  if (imageCount === 0) {
    kind = "text"; // ラスタ画像なし（テキスト/ベクター）。同経路で扱う。
  } else if (bitonal) {
    kind = "scan-bitonal"; // 2値スキャン: GS は DCT化で肥大するため pdfcpu 経路
  } else if (imageCoverage >= 0.5) {
    kind = anyColor ? "scan-color" : "scan-gray";
  } else {
    kind = "mixed";
  }

  return { pageCount, kind, imageCount, imagePages, imageCoverage, anyColor, bitonal, effectiveDpi, features };
}

// ---- ルーティング（候補計画） ----

export type CandidateEngine = EngineId | "passthrough";
export interface Candidate {
  engine: CandidateEngine;
  options: CompressionOptions;
}

/**
 * GS で使うオプションを内容に応じて選ぶ（balanced 固定をやめ、実効DPIで適応させる）。
 * データ準拠（RESULTS.md 第3/4回）で SSIM≥0.90 を優先する:
 *  - 高解像度スキャン（実効DPI ≥ 130）: balanced(100dpi) でダウンサンプル。~76%削減 / SSIM~0.95。
 *  - 低解像度スキャン（実効DPI < 130、または不明で画像あり）: すでに低精細。100へ落とすと
 *    画質を損なうだけなので quality(150dpi) を使い、ダウンサンプルせず JPEG 再エンコードのみで縮める。
 *  - override.preset が与えられればそれを優先（マニュアルモード/将来の探索・M4 の足場）。
 */
export function pickGsOptions(inspect: InspectResult, override?: CompressionOptions): CompressionOptions {
  // マニュアル/プリセット指定があればそれを優先（GS候補の設定を固定）。
  if (override && Object.keys(override).length > 0) return { ...override };
  const dpi = inspect.effectiveDpi;
  if (dpi > 0 && dpi < 130) return { preset: "quality" }; // 低精細は据え置き再エンコード
  return { preset: "balanced" };
}

/**
 * 種別 → 候補の順序（ADR-010）。ランナーは「有効かつ入力未満の最初」を採用し、
 * 無ければ passthrough（元ファイル＝常に入力以下）を採る。GS の設定は pickGsOptions で内容適応。
 *  - scan/mixed: 通常は GS(適応preset) が入力未満で採用。誤分類でGSが肥大→ガード除外→pdfcpu→passthrough。
 *  - scan-bitonal: GS を避け pdfcpu→passthrough。
 *  - text/vector(画像なし): GS を先に試し、肥大すればガードで除外され pdfcpu が採られる。
 *    ベクターのように GS が縮む場合は GS が採用される。
 */
export function planCandidates(inspect: InspectResult, override?: CompressionOptions): Candidate[] {
  const gs: Candidate = { engine: "ghostscript-wasm", options: pickGsOptions(inspect, override) };
  const pdfcpu: Candidate = { engine: "pdfcpu-wasm", options: {} };
  const passthrough: Candidate = { engine: "passthrough", options: {} };

  if (inspect.kind === "scan-bitonal") return [pdfcpu, passthrough];
  return [gs, pdfcpu, passthrough];
}

/** 処理中の進捗イベント（ADR-008 CompressProgress 相当）。GS は途中経過を出せないためフェーズ粒度。 */
export interface CompressProgress {
  phase: "inspecting" | "compressing";
  engine?: CandidateEngine;
  preset?: string;
  attempt?: number; // 何番目の候補か（1始まり）
  total?: number; // 候補総数
}

/** compressSmart（inspect→ルーティング→ガード）の結果 */
export interface SmartCompressResult {
  kind: ContentKind;
  inspect: InspectResult;
  chosenEngine: CandidateEngine;
  chosenPreset?: string;
  inputBytes: number;
  outputBytes: number;
  reduction: number;
  compressMs: number;
  inspectMs: number;
  tried: string[];
  output: Uint8Array;
}
