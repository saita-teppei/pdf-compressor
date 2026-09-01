/**
 * 計測ハーネス (ADR-005 / METHODOLOGY.md) — 多エンジン対応。
 *
 * corpus/manifest.json を読み込み、指定エンジン×条件で各サンプルを圧縮し、
 * 出力サイズ・削減率・処理時間を results.json に記録する。出力PDFは out/ に保存。
 * 頁維持は verify_pages.py、画質(SSIM)は compute_ssim.py で別途評価する。
 *
 * 使い方:
 *   node run-bench.mjs                 # 既定: gs + pdfcpu 両方
 *   node run-bench.mjs --engines gs
 *   node run-bench.mjs --only scan-color-medium-01,photo-medium-01
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// gs はモジュール生成ごとに process へ例外ハンドラを積むため上限警告が出る。無害なので解除。
process.setMaxListeners(0);

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(HERE, "..");
const MANIFEST = resolve(BENCH_ROOT, "corpus", "manifest.json");
const OUT_DIR = resolve(HERE, "out");
const RESULTS = resolve(HERE, "results.json");

const ENGINE_MODULES = {
  gs: "./gs-engine.mjs",
  pdfcpu: "./pdfcpu-engine.mjs",
};

function parseArgs() {
  const a = { engines: ["gs", "pdfcpu"], only: null };
  for (let i = 2; i < process.argv.length; i++) {
    const t = process.argv[i];
    if (t === "--engines") a.engines = process.argv[++i].split(",");
    else if (t === "--only") a.only = new Set(process.argv[++i].split(","));
  }
  return a;
}

const pct = (x) => (x * 100).toFixed(1) + "%";

async function main() {
  const opts = parseArgs();
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  let samples = manifest.samples;
  if (opts.only) samples = samples.filter((s) => opts.only.has(s.id));

  const engines = [];
  for (const key of opts.engines) {
    const mod = await import(ENGINE_MODULES[key]);
    engines.push(mod);
    console.log(`engine: ${mod.engineInfo.id} (${mod.engineInfo.license}), wasm ${(mod.engineInfo.wasmBytes / 1e6).toFixed(1)} MB, conditions: ${mod.conditions.map((c) => c.label).join(", ")}`);
  }
  console.log(`samples: ${samples.length}\n`);

  const results = [];
  for (const eng of engines) {
    for (const s of samples) {
      const input = readFileSync(resolve(BENCH_ROOT, s.path));
      for (const cond of eng.conditions) {
        let r;
        try {
          r = await eng.compress(input, cond.options);
        } catch (e) {
          console.log(`  ${eng.id} ${s.id} [${cond.label}] ERROR ${e.message}`);
          results.push({ engine: eng.id, id: s.id, category: s.category, preset: cond.label, error: String(e.message) });
          continue;
        }
        const outName = `${s.id}__${eng.id}__${cond.label}.pdf`;
        if (r.valid) writeFileSync(resolve(OUT_DIR, outName), r.blob);
        results.push({
          engine: eng.id,
          id: s.id,
          category: s.category,
          preset: cond.label,
          inputBytes: r.inputBytes,
          outputBytes: r.outputBytes,
          reductionRatio: Number(r.reductionRatio.toFixed(4)),
          initMs: Math.round(r.initMs),
          compressMs: Math.round(r.compressMs),
          exitCode: r.exitCode,
          valid: r.valid,
          outputFile: r.valid ? `out/${outName}` : null,
          manifestPages: s.pages,
        });
        console.log(
          `  ${eng.id.padEnd(15)} ${s.id.padEnd(22)} [${cond.label.padEnd(8)}] ` +
            `${(r.inputBytes / 1e6).toFixed(2)}→${(r.outputBytes / 1e6).toFixed(2)}MB ` +
            `red=${pct(r.reductionRatio).padStart(7)} ${Math.round(r.compressMs)}ms ${r.valid ? "ok" : "INVALID"}`,
        );
      }
    }
  }

  writeFileSync(
    RESULTS,
    JSON.stringify(
      { engines: engines.map((e) => e.engineInfo), generatedAt: new Date().toISOString(), node: process.version, results },
      null,
      2,
    ),
  );
  console.log(`\n[OK] results -> ${RESULTS}`);
  console.log(`[OK] outputs -> ${OUT_DIR}`);
  console.log(`次: python verify_pages.py && python compute_ssim.py`);
}

main();
