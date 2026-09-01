/**
 * コンテンツ別ルーティング実証 (ADR-010 / ADR-002 用途別分離)。
 *
 * inspect_pdf.py の分類(inspect.json)に基づき、種別ごとに第一エンジン/設定を選ぶ。
 * さらに「ルーティング＋ガード＋フォールバック」で堅牢化する:
 *   候補 = [第一選択, pdfcpu, passthrough]
 *   各候補を実行し、入力以下(肥大化しない)で最小サイズの有効出力を採用。
 *   → 誤分類・bitonal・肥大化しても passthrough が最終保険となり、決して入力を超えない。
 *
 * naive ベースライン(常に GS balanced)と比較して、ルーティングの優位を示す。
 *
 * 使い方: node route.mjs
 * 出力: route-results.json (compute_ssim.py で SSIM 評価可)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as gs from "./gs-engine.mjs";
import * as pdfcpu from "./pdfcpu-engine.mjs";

process.setMaxListeners(0);
const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(HERE, "..");
const MANIFEST = resolve(BENCH_ROOT, "corpus", "manifest.json");
const INSPECT = resolve(HERE, "inspect.json");
const OUT_DIR = resolve(HERE, "out");
const RESULTS = resolve(HERE, "route-results.json");

// 種別 → 第一選択エンジン/設定
const POLICY = {
  "scan-color": { engine: "gs", label: "gs-balanced", options: { preset: "balanced" } },
  "scan-gray": { engine: "gs", label: "gs-balanced", options: { preset: "balanced" } },
  "scan-bitonal": { engine: "pdfcpu", label: "pdfcpu-optimize", options: {} }, // 真bitonalはGSが肥大→pdfcpu
  mixed: { engine: "gs", label: "gs-balanced", options: { preset: "balanced" } },
  vector: { engine: "gs", label: "gs-balanced", options: { preset: "balanced" } },
  text: { engine: "pdfcpu", label: "pdfcpu-optimize", options: {} },
};

async function runEngine(engine, input, options) {
  if (engine === "gs") return gs.compress(input, options);
  if (engine === "pdfcpu") return pdfcpu.compress(input, options);
  // passthrough
  return { blob: input, inputBytes: input.length, outputBytes: input.length, reductionRatio: 0, valid: true, compressMs: 0 };
}

const pct = (x) => (x * 100).toFixed(1) + "%";

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  const inspect = JSON.parse(readFileSync(INSPECT, "utf-8"));
  const classById = Object.fromEntries(inspect.samples.map((s) => [s.id, s.class]));

  const results = [];
  const compare = [];
  for (const s of manifest.samples) {
    const input = readFileSync(resolve(BENCH_ROOT, s.path));
    const cls = classById[s.id] ?? "text";
    const primary = POLICY[cls] ?? { engine: "gs", label: "gs-balanced", options: { preset: "balanced" } };

    // 候補: 第一選択 + pdfcpu + passthrough (重複ラベルは除外)
    const cands = [primary];
    if (primary.engine !== "pdfcpu") cands.push({ engine: "pdfcpu", label: "pdfcpu-optimize", options: {} });
    cands.push({ engine: "passthrough", label: "passthrough", options: {} });

    let best = null;
    for (const c of cands) {
      const r = await runEngine(c.engine, input, c.options);
      // ガード: 有効かつ入力以下のみ採用対象
      if (r.valid && r.outputBytes <= input.length) {
        if (!best || r.outputBytes < best.r.outputBytes) best = { c, r };
      }
    }
    // 万一全滅でも passthrough は必ず input 以下なので best は必ず存在
    const chosen = best;
    const outName = `${s.id}__routed.pdf`;
    writeFileSync(resolve(OUT_DIR, outName), chosen.r.blob);

    results.push({
      engine: `routed:${chosen.c.label}`,
      id: s.id,
      category: cls,               // inspect が導出した種別
      preset: "routed",
      inputBytes: input.length,
      outputBytes: chosen.r.outputBytes,
      reductionRatio: Number((1 - chosen.r.outputBytes / input.length).toFixed(4)),
      valid: true,
      outputFile: `out/${outName}`,
      manifestPages: s.pages,
      chosenEngine: chosen.c.label,
    });

    // naive: 常に GS balanced（比較用）
    const naive = await gs.compress(input, { preset: "balanced" });
    const naiveRed = naive.valid ? 1 - naive.outputBytes / input.length : -Infinity;
    compare.push({
      id: s.id, cls, chosen: chosen.c.label,
      routedRed: 1 - chosen.r.outputBytes / input.length,
      naiveGsRed: naiveRed,
      naiveInflated: naive.valid && naive.outputBytes > input.length,
    });

    console.log(
      `  ${s.id.padEnd(22)} ${cls.padEnd(13)} -> ${chosen.c.label.padEnd(16)} ` +
        `routed=${pct(1 - chosen.r.outputBytes / input.length).padStart(7)} ` +
        `(naive GS=${pct(naiveRed).padStart(8)}${compare.at(-1).naiveInflated ? " 肥大!" : ""})`,
    );
  }

  writeFileSync(RESULTS, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

  // サマリ
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log("\n=== ルーティング vs naive(GS balanced) ===");
  console.log(`routed 平均削減率     : ${pct(mean(compare.map((c) => c.routedRed)))}`);
  console.log(`naive  平均削減率     : ${pct(mean(compare.map((c) => (isFinite(c.naiveGsRed) ? c.naiveGsRed : 0))))}`);
  console.log(`naive で肥大したサンプル: ${compare.filter((c) => c.naiveInflated).length}/${compare.length}`);
  console.log(`routed で肥大したサンプル: ${results.filter((r) => r.reductionRatio < 0).length}/${results.length}`);
  console.log(`\n[OK] -> ${RESULTS}\n次: python compute_ssim.py route-results.json`);
}

main();
