<script>
  import { fade } from "svelte/transition";
  import {
    robotLive,
    robotReadout,
    robotPose,
    toggleRobotLive,
  } from "../lib/stores/robot.js";
  import {
    clearWifiSamples,
    setWifiMapEnabled,
    wifiMapEnabled,
    wifiSurveySummary,
  } from "../lib/stores/wifi.js";
  import { wifiSignalColor } from "../lib/wifi/signal.js";
  import { notify } from "../lib/stores/toast.js";

  $: ok = $robotLive && $robotPose?.ok;
  $: signalColor = wifiSignalColor($wifiSurveySummary.signalDbm);

  function toggleWifiMap() {
    const enabled = !$wifiMapEnabled;
    setWifiMapEnabled(enabled);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "not flushed yet";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  async function clearSurvey() {
    if (!window.confirm("Clear the shared WiFi signal map for all devices?")) return;
    try {
      await clearWifiSamples();
      notify("Shared WiFi survey cleared.", "success");
    } catch (_error) {
      notify("Could not clear the shared WiFi survey.", "warn");
    }
  }
</script>

<div class="glass w-[260px] rounded-2xl px-3 py-2.5">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 text-xs font-semibold">
      <span
        class="inline-block h-2 w-2 rounded-full"
        style="background:{ok ? 'var(--ok)' : $robotLive ? 'var(--warn)' : 'var(--subtle)'}"
      ></span>
      <span class="material-symbols-outlined" style="font-size:17px">radar</span>
      Live robot
    </div>
    <button
      class="btn-icon !h-7 !w-7"
      class:text-accent={$robotLive}
      title="Toggle live robot overlay"
      on:click={toggleRobotLive}
    >
      <span class="material-symbols-outlined" style="font-size:22px">
        {$robotLive ? "toggle_on" : "toggle_off"}
      </span>
    </button>
  </div>

  {#if $robotLive}
    <div transition:fade={{ duration: 140 }}>
      {#if $robotReadout}
        <pre class="mt-2 whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted">{$robotReadout}</pre>
      {:else}
        <p class="mt-2 text-[11px] text-subtle">Waiting for pose…</p>
      {/if}
    </div>
  {/if}

  <div class="mt-2 border-t pt-2" style="border-color:var(--glass-edge)">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-xs font-semibold">
        <span
          class="material-symbols-outlined"
          style="font-size:17px;color:{$wifiMapEnabled ? signalColor : 'var(--muted)'}"
        >signal_cellular_alt</span>
        WiFi signal map
      </div>
      <button
        class="btn-icon !h-7 !w-7"
        class:text-accent={$wifiMapEnabled}
        title="Toggle WiFi heatmap"
        on:click={toggleWifiMap}
      >
        <span class="material-symbols-outlined" style="font-size:22px">
          {$wifiMapEnabled ? "toggle_on" : "toggle_off"}
        </span>
      </button>
    </div>

    {#if $wifiMapEnabled}
      <div transition:fade={{ duration: 140 }}>
        <div class="mt-2 flex items-end justify-between gap-2">
          <div>
            <div class="text-lg font-semibold" style="color:{signalColor}">
              {$wifiSurveySummary.signalDbm == null
                ? "-- dBm"
                : `${Math.round($wifiSurveySummary.signalDbm)} dBm`}
            </div>
            <div class="text-[10px] text-subtle">
              {$wifiSurveySummary.signalDbm == null
                ? "Waiting for WiFi data…"
                : $wifiSurveySummary.label}
            </div>
          </div>
          <div class="text-right text-[10px] text-subtle">
            {$wifiSurveySummary.sampleCount} map points
          </div>
        </div>
        <div
          class="mt-2 h-2 rounded-full"
          style="background:linear-gradient(90deg,#ef4444 0%,#f97316 28%,#facc15 55%,#84cc16 76%,#22c55e 100%)"
          title="red: very weak · green: excellent"
        ></div>
        <div class="mt-1 flex justify-between text-[9px] text-subtle">
          <span>≤ -80 dBm</span>
          <span>≥ -55 dBm</span>
        </div>
        <div class="mt-2 text-[9px] leading-relaxed text-subtle">
          {$wifiSurveySummary.storage.collector?.enabled ? "Autonomous on mower" : "Browser fallback"} ·
          {Math.round(($wifiSurveySummary.storage.collector?.intervalMs || 10000) / 1000)} s sample ·
          {$wifiSurveySummary.storage.cellSizeM} m grid ·
          {Math.round($wifiSurveySummary.storage.flushIntervalMs / 1000)} s disk flush ·
          {formatBytes($wifiSurveySummary.storage.fileBytes)}
        </div>
        {#if $wifiSurveySummary.sampleCount > 0}
          <button class="mt-2 text-[10px] text-subtle hover:text-ink" on:click={clearSurvey}>
            Clear shared survey
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
