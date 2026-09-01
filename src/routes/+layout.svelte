<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";

  let { children } = $props();

  // AGPLv3 §13（COMPLIANCE.md §1/§2）: 稼働中のビルドに対応するソースへ常時到達できるようにする。
  // 値は vite.config.ts の define でビルド時に確定する（実行時の取得はしない）。
  const sourceUrl = __SOURCE_URL__;
  const commitHash = __COMMIT_HASH__;
  // git の無い環境でビルドされた場合はコミットを特定できないので、リポジトリ直下へ送る。
  const buildUrl = commitHash === "unknown" ? sourceUrl : `${sourceUrl}/commit/${commitHash}`;

  // Service Worker はバンドル経由で登録する（inline script を出さず CSP を厳格に保つ, ADR-004）。
  onMount(async () => {
    if ("serviceWorker" in navigator) {
      const { registerSW } = await import("virtual:pwa-register");
      registerSW({ immediate: true });
    }
  });
</script>

{@render children()}

<footer>
  <span>{m.footer_license()}</span>
  <a href={sourceUrl} rel="noopener noreferrer">{m.footer_source()}</a>
  <a href={buildUrl} rel="noopener noreferrer">{m.footer_build({ hash: commitHash })}</a>
</footer>

<style>
  footer {
    max-width: 46rem;
    margin: 0 auto;
    padding: 1rem 1rem 2rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    border-top: 1px solid #e3e8ee;
    font-family: system-ui, sans-serif;
    font-size: 0.85rem;
    color: #5a6572;
  }
  footer a {
    color: #1d4ed8;
    font-variant-numeric: tabular-nums;
  }
</style>
