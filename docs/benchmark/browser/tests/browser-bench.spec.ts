/**
 * 実ブラウザ計測ドライバ（PoC）。
 * コーパス × 条件を実ブラウザ(Chromium)の Web Worker で圧縮し、
 * 時間 / ロード / WASM線形メモリ / 出力サイズを browser-results[.mobile].json に記録する。
 * 出力 PDF は out/ に保存し、既存の verify_pages.py / compute_ssim.py へ渡して Node 実測と突き合わせる。
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = path.resolve(HERE, "..");
const BENCH_ROOT = path.resolve(BROWSER_DIR, ".."); // docs/benchmark
const CORPUS = path.join(BENCH_ROOT, "corpus");
const OUT = path.join(BROWSER_DIR, "out");

type Sample = { id: string; path: string; category: string; pages: number; sizeBytes: number };
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifest.json"), "utf8"));
const samples: Sample[] = manifest.samples;
const byId = (id: string) => samples.find((s) => s.id === id)!;

type Cond = { engine: "ghostscript-wasm" | "pdfcpu-wasm"; preset: string };
const CONDITIONS: Cond[] = [
  { engine: "ghostscript-wasm", preset: "max" },
  { engine: "ghostscript-wasm", preset: "balanced" },
  { engine: "ghostscript-wasm", preset: "quality" },
  { engine: "pdfcpu-wasm", preset: "optimize" },
];

// mobile は時間節約のため代表サンプル×balanced/optimize の部分集合のみ計測する
const MOBILE_SAMPLE_IDS = ["scan-color-medium-01", "photo-medium-01", "text-medium-01", "mixed-medium-01"];
const MOBILE_CONDS: Cond[] = [
  { engine: "ghostscript-wasm", preset: "balanced" },
  { engine: "pdfcpu-wasm", preset: "optimize" },
];

function optionsFor(c: Cond) {
  if (c.engine === "ghostscript-wasm") return { preset: c.preset };
  return {}; // pdfcpu は optimize 固定でオプション無視
}

function readB64(s: Sample): string {
  return fs.readFileSync(path.join(BENCH_ROOT, s.path)).toString("base64");
}

async function waitReady(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__benchReady === true, undefined, { timeout: 60000 });
}

test("browser engine measurement", async ({ page, context }, testInfo) => {
  const profile = testInfo.project.name; // 'desktop' | 'mobile'
  const isMobile = profile === "mobile";
  fs.mkdirSync(OUT, { recursive: true });

  // mobile は CDP で CPU を 4x スロットル（実機近似の参考値）
  if (isMobile) {
    const client = await context.newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await waitReady(page);

  // ---- 1) 機能検出（COI / メモリ計測 API / SAB） ----
  const selfCheck = await page.evaluate(() => (window as any).__bench.selfCheck());
  console.log(`[${profile}] selfCheck:`, JSON.stringify(selfCheck));

  // ---- 2) WASM ロード計測（cold=初回fetch / warm=IndexedDB） ----
  const loads: any[] = [];
  const engineIds: ("ghostscript-wasm" | "pdfcpu-wasm")[] = ["ghostscript-wasm", "pdfcpu-wasm"];
  await page.evaluate(() => (window as any).__bench.clearCache());
  for (const id of engineIds) {
    const cold = await page.evaluate((eid) => (window as any).__bench.freshLoad(eid), id);
    const warm = await page.evaluate((eid) => (window as any).__bench.freshLoad(eid), id);
    loads.push({ engineId: id, cold, warm });
    console.log(
      `[${profile}] load ${id}: cold ${cold.loadMs.toFixed(0)}ms(fetch) +${cold.compileMs.toFixed(0)}ms(compile), ` +
        `warm ${warm.loadMs.toFixed(0)}ms(idb) +${warm.compileMs.toFixed(0)}ms, ${(cold.wasmBytes / 1e6).toFixed(1)}MB`,
    );
  }

  // ---- 3) コーパス × 条件で圧縮計測 ----
  const results: any[] = [];
  const targetSamples = isMobile ? samples.filter((s) => MOBILE_SAMPLE_IDS.includes(s.id)) : samples;
  const targetConds = isMobile ? MOBILE_CONDS : CONDITIONS;

  for (const s of targetSamples) {
    const inB64 = readB64(s);
    for (const c of targetConds) {
      const outName = `${s.id}__${c.engine}__${c.preset}.pdf`;
      const row: any = {
        id: s.id,
        category: s.category,
        engine: c.engine,
        preset: c.preset,
        manifestPages: s.pages,
        inputBytes: s.sizeBytes,
        outputFile: `../browser/out/${outName}`,
        profile,
      };
      try {
        const { metrics, outputB64 } = await page.evaluate(
          (args) => (window as any).__bench.compress(args.engine, args.inB64, args.options),
          { engine: c.engine, inB64, options: optionsFor(c) },
        );
        Object.assign(row, {
          outputBytes: metrics.outputBytes,
          reductionRatio: metrics.reductionRatio,
          initMs: Math.round(metrics.initMs),
          compressMs: Math.round(metrics.compressMs),
          wasmHeapBytes: metrics.wasmHeapBytes,
          memFactor: metrics.wasmHeapBytes ? +(metrics.wasmHeapBytes / s.sizeBytes).toFixed(2) : null,
          exitCode: metrics.exitCode,
          valid: metrics.valid,
        });
        // desktop のみ出力 PDF を保存（検証用）。mobile は時間節約で保存しない
        if (!isMobile && metrics.valid && outputB64) {
          fs.writeFileSync(path.join(OUT, outName), Buffer.from(outputB64, "base64"));
        }
        console.log(
          `[${profile}] ${s.id.padEnd(22)} ${c.engine.padEnd(16)} ${c.preset.padEnd(9)} ` +
            `red ${(row.reductionRatio * 100).toFixed(1).padStart(6)}%  ${row.compressMs}ms  ` +
            `mem ${row.wasmHeapBytes ? (row.wasmHeapBytes / 1e6).toFixed(0) + "MB(x" + row.memFactor + ")" : "-"}`,
        );
      } catch (e: any) {
        row.error = String(e?.message ?? e);
        row.valid = false;
        console.log(`[${profile}] ${s.id} ${c.engine} ${c.preset} ERROR ${row.error}`);
      }
      results.push(row);
    }
  }

  // ---- 4) キャンセル（terminate）検証 + 復旧確認（desktop のみ） ----
  let cancel: any = null;
  if (!isMobile) {
    const bigB64 = readB64(byId("scan-color-medium-01"));
    const smallB64 = readB64(byId("text-small-01"));
    const ct = await page.evaluate(
      (args) => (window as any).__bench.cancelTest(args.b64, { preset: "max" }, 40),
      { b64: bigB64 },
    );
    const rec = await page.evaluate(
      (args) => (window as any).__bench.recoverCheck(args.b64, { preset: "balanced" }),
      { b64: smallB64 },
    );
    cancel = { ...ct, recovered: rec.valid, recoverMs: Math.round(rec.compressMs) };
    console.log(`[${profile}] cancel:`, JSON.stringify(cancel));
  }

  // ---- 5) 結果書き出し ----
  const report = {
    meta: {
      profile,
      generatedAt: new Date().toISOString(),
      selfCheck,
      loads,
      cancel,
      consoleErrors,
      note:
        "実ブラウザ(Chromium)計測。mobile はデバイスエミュレーション+CPU4xスロットルの参考値（実機ではない）。",
    },
    results,
  };
  const outJson = isMobile ? "browser-results-mobile.json" : "browser-results.json";
  fs.writeFileSync(path.join(BROWSER_DIR, outJson), JSON.stringify(report, null, 2));
  console.log(`[${profile}] wrote ${outJson} (${results.length} rows)`);

  // ---- 6) NFR ソフト検証（未達でも run は完走。RESULTS/ADR に反映する） ----
  const okRows = results.filter((r) => r.valid && !r.error);
  expect.soft(okRows.length, "有効な圧縮結果が存在する").toBeGreaterThan(0);
  // 頁維持は Python(verify_pages.py) で最終確認。ここでは exit/valid のみ担保
  for (const r of okRows) {
    expect.soft(r.exitCode, `${r.id}/${r.engine}/${r.preset} exitCode`).toBe(0);
  }
  // SAB 不使用の前提（ADR-004）。crossOriginIsolated は false のはず
  expect.soft(selfCheck.crossOriginIsolated, "COI 無し(ADR-004)").toBe(false);
  // コンソールエラーが無いこと（移植の健全性）
  expect.soft(consoleErrors, "console/page エラー無し").toEqual([]);
});
