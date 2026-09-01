/**
 * パラメータ探索ハーネス (ADR-005/008) — マニュアルモードの設定面を実測で詰める。
 *
 * 明示 DPI × JPEG quality のグリッドで Ghostscript を回し、削減率と(後段の)SSIM から
 * 「SSIM≥0.90 を保ちつつ最大削減となる設定」を見つけ、プリセット値の根拠にする。
 * これはマニュアルモード(任意設定)の探索でもある。
 *
 * 画像パラメータが効くカテゴリ(スキャン/写真/混在)の medium サンプルに絞って実行する。
 *
 * 使い方:
 *   node explore-params.mjs
 *   node explore-params.mjs --only scan-color-medium-01
 * 出力: explore-results.json (results.json と同一スキーマ; compute_ssim.py で評価)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compress, engineInfo } from "./gs-engine.mjs";

process.setMaxListeners(0);

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(HERE, "..");
const MANIFEST = resolve(BENCH_ROOT, "corpus", "manifest.json");
const OUT_DIR = resolve(HERE, "out");
const RESULTS = resolve(HERE, "explore-results.json");

// 探索グリッド (ADR-002 の探索パラメータに準拠、quality は代表3点に絞る)
const DPIS = [72, 100, 150, 200, 300];
const QUALITIES = [40, 60, 80];

// 画像圧縮が効く medium カテゴリ
const DEFAULT_TARGETS = [
  "scan-color-medium-01",
  "scan-gray-medium-01",
  "photo-medium-01",
  "mixed-medium-01",
];

function parseArgs() {
  const a = { only: null };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--only") a.only = new Set(process.argv[++i].split(","));
  }
  return a;
}

const pct = (x) => (x * 100).toFixed(1) + "%";

async function main() {
  const opts = parseArgs();
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  const targetIds = opts.only ?? new Set(DEFAULT_TARGETS);
  const samples = manifest.samples.filter((s) => targetIds.has(s.id));

  console.log(`engine: ${engineInfo.id}, grid: dpi[${DPIS}] x q[${QUALITIES}], targets: ${samples.length}\n`);
  const results = [];
  for (const s of samples) {
    const input = readFileSync(resolve(BENCH_ROOT, s.path));
    for (const dpi of DPIS) {
      for (const jpegQuality of QUALITIES) {
        const label = `dpi${dpi}_q${jpegQuality}`;
        let r;
        try {
          r = await compress(input, { dpi, jpegQuality });
        } catch (e) {
          results.push({ engine: engineInfo.id, id: s.id, category: s.category, preset: label, error: String(e.message) });
          continue;
        }
        const outName = `${s.id}__gs__${label}.pdf`;
        if (r.valid) writeFileSync(resolve(OUT_DIR, outName), r.blob);
        results.push({
          engine: engineInfo.id,
          id: s.id,
          category: s.category,
          preset: label,
          dpi,
          jpegQuality,
          inputBytes: r.inputBytes,
          outputBytes: r.outputBytes,
          reductionRatio: Number(r.reductionRatio.toFixed(4)),
          compressMs: Math.round(r.compressMs),
          valid: r.valid,
          outputFile: r.valid ? `out/${outName}` : null,
          manifestPages: s.pages,
        });
        console.log(`  ${s.id.padEnd(22)} ${label.padEnd(12)} ${(r.outputBytes / 1e6).toFixed(2)}MB red=${pct(r.reductionRatio).padStart(7)} ${Math.round(r.compressMs)}ms`);
      }
    }
  }
  writeFileSync(RESULTS, JSON.stringify({ engines: [engineInfo], grid: { DPIS, QUALITIES }, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\n[OK] -> ${RESULTS}`);
  console.log(`次: python compute_ssim.py explore-results.json && python analyze_explore.py`);
}

main();
