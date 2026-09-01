<script lang="ts">
  import { createCompressor, type Compressor } from "$lib/worker/client";
  import type { CompressionOptions } from "$lib/engines/engine-contract";
  import { zipSync } from "fflate";
  import { m } from "$lib/paraglide/messages";
  import { getLocale, setLocale, locales } from "$lib/paraglide/runtime";

  type JobStatus = "queued" | "working" | "done" | "error";
  interface Job {
    id: number;
    file: File;
    name: string;
    inputBytes: number;
    status: JobStatus;
    phase?: string; // 処理中の進捗テキスト
    // 完了時
    outputBytes?: number;
    reduction?: number;
    ms?: number;
    grew?: boolean;
    kind?: string;
    route?: string;
    preset?: string;
    dpi?: number;
    url?: string;
    downloadName?: string;
    error?: string;
    override?: CompressionOptions;
    warnings?: string[];
  }

  type Mode = "auto" | "preset" | "manual";

  let jobs = $state<Job[]>([]);
  let dragOver = $state(false);
  let processing = $state(false);
  let seq = 0;

  let compressor: Compressor | null = null;
  // キャンセル用（非リアクティブ）: 実行中の race を reject する関数と、キュー中断フラグ
  let currentCancel: (() => void) | null = null;
  let cancelRun = false;

  // 圧縮モード設定（ADR-007）。auto=コンテンツ別ルーティング(既定), preset/manual は GS 設定を固定。
  let mode = $state<Mode>("auto");
  let presetSel = $state<"max" | "balanced" | "quality">("balanced");
  let manDpi = $state(150);
  let manQuality = $state(75);
  let manColor = $state<"color" | "grayscale" | "monochrome">("color");

  function buildOverride(): CompressionOptions | undefined {
    if (mode === "auto") return undefined;
    if (mode === "preset") return { preset: presetSel };
    return { dpi: manDpi, jpegQuality: manQuality, colorMode: manColor };
  }

  function kindLabel(k: string): string {
    switch (k) {
      case "scan-color": return m.kind_scan_color();
      case "scan-gray": return m.kind_scan_gray();
      case "scan-bitonal": return m.kind_scan_bitonal();
      case "mixed": return m.kind_mixed();
      case "text": return m.kind_text();
      default: return k;
    }
  }
  function routeLabel(r: string): string {
    if (r === "ghostscript-wasm") return "Ghostscript";
    if (r === "pdfcpu-wasm") return "pdfcpu";
    if (r === "passthrough") return m.route_passthrough();
    return r;
  }

  const otherLocale = () => locales.find((l) => l !== getLocale()) ?? getLocale();

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function isPdf(f: File): boolean {
    return f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf";
  }

  function addFiles(files: File[]) {
    const override = buildOverride(); // 追加時点の設定を各ジョブに固定
    for (const file of files) {
      const id = ++seq;
      if (!isPdf(file)) {
        jobs.push({ id, file, name: file.name, inputBytes: file.size, status: "error", error: m.err_not_pdf() });
        continue;
      }
      jobs.push({ id, file, name: file.name, inputBytes: file.size, status: "queued", override });
    }
    void processQueue();
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    cancelRun = false;
    try {
      compressor ??= createCompressor();
      for (;;) {
        if (cancelRun) break;
        const job = jobs.find((j) => j.status === "queued");
        if (!job) break;
        await processOne(job);
      }
    } finally {
      if (cancelRun) {
        // 残りの待機ジョブをキャンセル扱いにする
        for (const j of jobs) if (j.status === "queued") { j.status = "error"; j.error = "キャンセル"; }
      }
      cancelRun = false;
      currentCancel = null;
      processing = false;
    }
  }

  /** 実行中ジョブを中断する（GS callMain は中断不可のため Worker を terminate, ADR-008 §5）。 */
  function cancelAll() {
    cancelRun = true;
    currentCancel?.(); // 実行中の race を reject
    compressor?.terminate();
    compressor = null; // 次回は新規 Worker を作る
  }

  async function processOne(job: Job) {
    job.status = "working";
    job.phase = m.prog_inspecting();
    try {
      const buf = await job.file.arrayBuffer();
      // フェーズ進捗（解析中→各エンジンで圧縮中）を受け取り表示する。
      const onProgress = (p: { phase: string; engine?: string }) => {
        job.phase =
          p.phase === "inspecting" ? m.prog_inspecting() : m.prog_compressing({ engine: routeLabel(p.engine ?? "") });
      };
      // compress とキャンセルを競走させ、terminate 後もハングしないようにする
      const cancelP = new Promise<never>((_, reject) => {
        currentCancel = () => reject(new DOMException("cancelled", "AbortError"));
      });
      // $state 配列内のオブジェクトは Proxy 化されており postMessage でクローンできないため、
      // プレーンなスナップショットにしてから Worker へ渡す。
      const work = compressor!.compressSmart(
        buf,
        $state.snapshot(job.override) as CompressionOptions | undefined,
        onProgress,
      );
      work.catch(() => {}); // terminate 後に来る reject を握りつぶし unhandledrejection を防ぐ
      const res = await Promise.race([work, cancelP]);
      currentCancel = null;
      const grew = res.chosenEngine === "passthrough";
      const outBlob = grew ? job.file : new Blob([res.output as BlobPart], { type: "application/pdf" });
      job.url = URL.createObjectURL(outBlob);
      job.outputBytes = res.outputBytes;
      job.reduction = res.reduction;
      job.ms = Math.round(res.compressMs + res.inspectMs);
      job.grew = grew;
      job.kind = res.kind;
      job.route = res.chosenEngine;
      job.preset = res.chosenPreset;
      job.dpi = res.inspect.effectiveDpi;
      job.downloadName = grew ? job.name : `compressed-${job.name}`;
      // 機能保全の明示（ADR-006）: 圧縮で失われうる要素を通知する。
      const f = res.inspect.features;
      const w: string[] = [];
      if (f.signatures) w.push(m.warn_signature());
      if (f.form) w.push(m.warn_form());
      if (f.tagged) w.push(m.warn_tagged());
      job.warnings = w;
      job.status = "done";
    } catch (e) {
      job.status = "error";
      const msg = (e as { name?: string })?.name === "AbortError"
        ? m.btn_cancel()
        : e instanceof Error && e.message === "ENCRYPTED_UNSUPPORTED"
          ? m.err_encrypted()
          : e instanceof Error
            ? e.message
            : String(e);
      job.error = msg;
    }
  }

  function clearAll() {
    for (const j of jobs) if (j.url) URL.revokeObjectURL(j.url);
    jobs = [];
  }

  let zipping = $state(false);

  /** 完了ジョブの出力をまとめて zip でダウンロードする（fflate, store=無圧縮）。 */
  async function downloadZip() {
    const done = jobs.filter((j) => j.status === "done" && j.url);
    if (done.length === 0) return;
    zipping = true;
    try {
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (const j of done) {
        const bytes = new Uint8Array(await (await fetch(j.url!)).arrayBuffer());
        let name = j.downloadName ?? j.name;
        if (used.has(name)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          let k = 2;
          while (used.has(`${base}_${k}${ext}`)) k++;
          name = `${base}_${k}${ext}`;
        }
        used.add(name);
        files[name] = bytes;
      }
      // PDF は既に圧縮済みのため store(level 0) で十分・高速。
      const zipped = zipSync(files, { level: 0 });
      const url = URL.createObjectURL(new Blob([zipped as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "compressed-pdfs.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally {
      zipping = false;
    }
  }

  function onInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) addFiles(Array.from(input.files));
    input.value = ""; // 同じファイルの再選択を許可
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files?.length) addFiles(Array.from(e.dataTransfer.files));
  }

  // <html lang> を現在ロケールに合わせる（setLocale はページ再読込するのでマウント時に確定）。
  $effect(() => {
    document.documentElement.lang = getLocale();
  });

  const doneCount = $derived(jobs.filter((j) => j.status === "done").length);
  const errorCount = $derived(jobs.filter((j) => j.status === "error").length);
  const totals = $derived.by(() => {
    const done = jobs.filter((j) => j.status === "done");
    const inB = done.reduce((s, j) => s + j.inputBytes, 0);
    const outB = done.reduce((s, j) => s + (j.outputBytes ?? 0), 0);
    return { inB, outB, saved: inB ? 1 - outB / inB : 0 };
  });
</script>

<svelte:head>
  <title>{m.app_title()}</title>
</svelte:head>

<main>
  <div class="topbar">
    <h1>{m.app_title()}</h1>
    <button type="button" class="lang" onclick={() => setLocale(otherLocale())} aria-label={m.lang_label()}>
      {otherLocale().toUpperCase()}
    </button>
  </div>
  <p class="lead">{m.lead()}</p>

  <fieldset class="settings">
    <legend>{m.mode_legend()}</legend>
    <div class="modes">
      <label><input type="radio" name="mode" value="auto" bind:group={mode} /> {m.mode_auto()}</label>
      <label><input type="radio" name="mode" value="preset" bind:group={mode} /> {m.mode_preset()}</label>
      <label><input type="radio" name="mode" value="manual" bind:group={mode} /> {m.mode_manual()}</label>
    </div>

    {#if mode === "auto"}
      <p class="hint">{m.hint_auto()}</p>
    {:else if mode === "preset"}
      <label class="ctl">
        {m.label_preset()}
        <select bind:value={presetSel}>
          <option value="max">{m.preset_max()}</option>
          <option value="balanced">{m.preset_balanced()}</option>
          <option value="quality">{m.preset_quality()}</option>
        </select>
      </label>
    {:else}
      <div class="manual">
        <label class="ctl">
          {m.label_dpi()}: <b>{manDpi}</b>
          <input type="range" min="72" max="300" step="1" bind:value={manDpi} />
        </label>
        <label class="ctl">
          {m.label_quality()}: <b>{manQuality}</b>
          <input type="range" min="1" max="100" step="1" bind:value={manQuality} />
        </label>
        <label class="ctl">
          {m.label_color()}
          <select bind:value={manColor}>
            <option value="color">{m.color_color()}</option>
            <option value="grayscale">{m.color_grayscale()}</option>
            <option value="monochrome">{m.color_monochrome()}</option>
          </select>
        </label>
      </div>
      <p class="hint">{m.hint_manual()}</p>
    {/if}
    {#if mode !== "auto"}
      <p class="hint small">{m.hint_routing()}</p>
    {/if}
  </fieldset>

  <label
    class="dropzone"
    class:over={dragOver}
    ondragover={(e) => {
      e.preventDefault();
      dragOver = true;
    }}
    ondragleave={() => (dragOver = false)}
    ondrop={onDrop}
  >
    <input type="file" accept="application/pdf,.pdf" multiple onchange={onInput} class="vh" aria-label={m.dropzone_aria()} />
    <span>{m.dropzone()}</span>
  </label>

  {#if jobs.length > 0}
    <div class="bar">
      <span aria-live="polite">
        {m.progress({ total: jobs.length, done: doneCount })}{processing ? m.processing_suffix() : ""}
      </span>
      <progress class="prog" value={doneCount} max={jobs.length} aria-label={m.progress({ total: jobs.length, done: doneCount })}></progress>
      {#if processing}
        <button type="button" class="cancel" onclick={cancelAll}>{m.btn_cancel()}</button>
      {:else}
        {#if doneCount > 1}
          <button type="button" class="zip" onclick={downloadZip} disabled={zipping}>
            {zipping ? m.btn_zip_working() : m.btn_zip()}
          </button>
        {/if}
        <button type="button" onclick={clearAll}>{m.btn_clear()}</button>
      {/if}
    </div>

    <ul class="jobs">
      {#each jobs as job (job.id)}
        <li class="job" class:err={job.status === "error"}>
          <div class="row1">
            <span class="name" title={job.name}>{job.name}</span>
            <span class="status s-{job.status}">
              {#if job.status === "queued"}{m.status_queued()}
              {:else if job.status === "working"}{m.status_working()}
              {:else if job.status === "error"}{m.status_error()}
              {:else}{m.status_done()}{/if}
            </span>
          </div>
          {#if job.status === "done"}
            <div class="row2">
              <span>{fmtBytes(job.inputBytes)} → <b>{fmtBytes(job.outputBytes!)}</b></span>
              <span class="red" class:good={(job.reduction ?? 0) > 0}>
                {m.reduction({ pct: ((job.reduction ?? 0) * 100).toFixed(1) })}
              </span>
              <span class="meta">
                {kindLabel(job.kind ?? "")}
                → {routeLabel(job.route ?? "")}{job.preset ? ` / ${job.preset}` : ""}
              </span>
              <a class="dl" href={job.url} download={job.downloadName}>{m.download()}</a>
            </div>
            {#if job.grew}
              <div class="note">{m.note_grew()}</div>
            {/if}
            {#if job.warnings && job.warnings.length > 0}
              <div class="warn">⚠ {job.warnings.join(" ／ ")}</div>
            {/if}
          {:else if job.status === "working"}
            <div class="row2 working">
              <span class="phase">{job.phase ?? m.status_working()}</span>
              <span class="ibar" aria-hidden="true"></span>
            </div>
          {:else if job.status === "error"}
            <div class="row2 errmsg">{m.err_prefix()}: {job.error}</div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if doneCount > 1}
      <div class="summary" aria-live="polite">
        {m.summary({ inSize: fmtBytes(totals.inB), outSize: fmtBytes(totals.outB) })}
        <span class="red good">{m.summary_saved({ pct: (totals.saved * 100).toFixed(1) })}</span>
        {#if errorCount > 0}<span class="fail">{m.summary_fail({ count: errorCount })}</span>{/if}
      </div>
    {/if}
  {/if}
</main>

<style>
  main {
    max-width: 46rem;
    margin: 0 auto;
    padding: 2rem 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.6;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h1 {
    font-size: 1.6rem;
    margin-bottom: 0.25rem;
  }
  .lang {
    flex: none;
    padding: 0.3rem 0.7rem;
    border: 1px solid #cbd2db;
    background: #fff;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    color: #334;
  }
  .lang:hover {
    border-color: #2563eb;
    color: #1d4ed8;
  }
  .lead {
    color: #555;
    margin-top: 0;
  }
  .settings {
    border: 1px solid #e3e6ea;
    border-radius: 12px;
    padding: 0.75rem 1rem 1rem;
    margin-bottom: 1rem;
  }
  .settings legend {
    padding: 0 0.4rem;
    font-weight: 600;
    color: #445;
  }
  .modes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.1rem;
  }
  .modes label {
    cursor: pointer;
  }
  .ctl {
    display: block;
    margin-top: 0.7rem;
  }
  .ctl input[type="range"] {
    width: 100%;
    accent-color: #2563eb;
  }
  .ctl select {
    margin-left: 0.4rem;
    padding: 0.2rem 0.4rem;
  }
  .manual {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3rem 1.2rem;
  }
  .manual .ctl:last-child {
    grid-column: 1 / -1;
    max-width: 16rem;
  }
  .hint {
    color: #667;
    font-size: 0.85rem;
    margin: 0.6rem 0 0;
  }
  .hint.small {
    font-size: 0.78rem;
    color: #5b6270;
  }
  .dropzone {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 7rem;
    padding: 1.25rem;
    border: 2px dashed #b0b8c4;
    border-radius: 12px;
    color: #556;
    text-align: center;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .dropzone:hover,
  .dropzone.over {
    border-color: #3b82f6;
    background: #f0f6ff;
  }
  .dropzone:focus-within {
    border-color: #2563eb;
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  /* スクリーンリーダー用に残しつつ視覚的に隠す（キーボードフォーカス可能） */
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 1.25rem 0 0.5rem;
    color: #445;
    font-size: 0.9rem;
  }
  .bar button {
    padding: 0.35rem 0.8rem;
    border: 1px solid #cbd2db;
    background: #fff;
    border-radius: 8px;
    cursor: pointer;
  }
  .bar button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bar button.cancel {
    border-color: #e0a3a3;
    color: #b00020;
  }
  .bar button.zip {
    border-color: #2563eb;
    color: #1d4ed8;
    font-weight: 600;
  }
  .prog {
    flex: 1;
    height: 0.5rem;
    accent-color: #2563eb;
  }
  .jobs {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .job {
    border: 1px solid #e3e6ea;
    border-radius: 10px;
    padding: 0.6rem 0.85rem;
  }
  .job.err {
    border-color: #f2c2c2;
    background: #fff6f6;
  }
  .row1 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    flex: none;
    font-size: 0.8rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    background: #eef1f5;
    color: #556;
  }
  .status.s-done {
    background: #e6f5ec;
    color: #0a7a2f;
  }
  .status.s-working {
    background: #fff4e0;
    color: #a15c00;
  }
  .status.s-error {
    background: #fdeaea;
    color: #b00020;
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.9rem;
    margin-top: 0.35rem;
    font-size: 0.9rem;
  }
  .row2 .red {
    font-variant-numeric: tabular-nums;
  }
  .row2 .red.good {
    color: #0a7a2f;
    font-weight: 600;
  }
  .row2 .meta {
    color: #667;
    font-size: 0.85rem;
  }
  .row2.errmsg {
    color: #b00020;
  }
  .row2.working {
    gap: 0.6rem;
  }
  .row2.working .phase {
    color: #a15c00;
    font-size: 0.88rem;
    flex: none;
  }
  .ibar {
    position: relative;
    flex: 1;
    min-width: 80px;
    height: 4px;
    background: #eef1f5;
    border-radius: 2px;
    overflow: hidden;
  }
  .ibar::after {
    content: "";
    position: absolute;
    left: -40%;
    width: 40%;
    height: 100%;
    background: #2563eb;
    border-radius: 2px;
    animation: ibar-slide 1.1s infinite ease-in-out;
  }
  @keyframes ibar-slide {
    0% {
      left: -40%;
    }
    100% {
      left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ibar::after {
      animation: none;
      left: 0;
      width: 100%;
      opacity: 0.5;
    }
  }
  .dl {
    margin-left: auto;
    padding: 0.3rem 0.8rem;
    background: #2563eb;
    color: #fff;
    border-radius: 8px;
    text-decoration: none;
    font-weight: 600;
  }
  .dl:hover {
    background: #1d4ed8;
  }
  .note {
    margin-top: 0.35rem;
    color: #8a6d00;
    background: #fff8e1;
    padding: 0.35rem 0.55rem;
    border-radius: 8px;
    font-size: 0.85rem;
  }
  .warn {
    margin-top: 0.35rem;
    color: #8a3b00;
    background: #fff1e6;
    padding: 0.35rem 0.55rem;
    border-radius: 8px;
    font-size: 0.85rem;
  }
  .summary {
    margin-top: 0.9rem;
    padding: 0.6rem 0.85rem;
    border: 1px solid #d7e0ea;
    background: #f6f9fe;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
  }
  .summary .fail {
    color: #b00020;
    margin-left: 0.4rem;
  }
</style>
