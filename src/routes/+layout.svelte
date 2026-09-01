<script lang="ts">
  import { onMount } from "svelte";

  let { children } = $props();

  // Service Worker はバンドル経由で登録する（inline script を出さず CSP を厳格に保つ, ADR-004）。
  onMount(async () => {
    if ("serviceWorker" in navigator) {
      const { registerSW } = await import("virtual:pwa-register");
      registerSW({ immediate: true });
    }
  });
</script>

{@render children()}
