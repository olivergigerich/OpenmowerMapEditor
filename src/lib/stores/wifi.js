import { derived, get, writable } from "svelte/store";
import { deleteWifiMap, fetchWifiMap, recordWifiSamples } from "../api.js";
import { mergeWifiSample, wifiPercentFromDbm, wifiSignalLabel } from "../wifi/signal.js";

const ENABLED_KEY = "openmower-map-editor-wifi-map-enabled";
const LEGACY_SAMPLES_KEY = "openmower-map-editor-wifi-map-v1";
const SYNC_MS = 15000;
const MIN_RECORD_MS = 2000;
const STATIONARY_RECORD_MS = 5000;

function loadEnabled() {
  return typeof localStorage !== "undefined" && localStorage.getItem(ENABLED_KEY) === "1";
}

export const wifiMapEnabled = writable(loadEnabled());
export const wifiSamples = writable([]);
export const latestWifiSignal = writable(null);
export const wifiSurveyStorage = writable({
  central: true,
  cellSizeM: 0.75,
  maxPoints: 2000,
  flushIntervalMs: 30000,
  fileBytes: 0,
  collector: {
    enabled: true,
    intervalMs: 10000,
    cellRevisitMs: 300000,
  },
});

wifiMapEnabled.subscribe((enabled) => {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  }
});

export const wifiSurveySummary = derived(
  [wifiSamples, latestWifiSignal, wifiSurveyStorage],
  ([$samples, $latest, $storage]) => ({
    sampleCount: $samples.length,
    signalDbm: $latest?.signalDbm ?? null,
    percent: wifiPercentFromDbm($latest?.signalDbm),
    label: wifiSignalLabel($latest?.signalDbm),
    interface: $latest?.interface || null,
    storage: $storage,
  })
);

let knownRevision = null;
let syncPromise = null;
let recordInFlight = false;
let lastRecordAt = 0;
let lastRecordCell = null;

function applyServerPayload(data) {
  if (Number.isFinite(data?.revision)) knownRevision = data.revision;
  if (data?.storage) wifiSurveyStorage.set(data.storage);
  const collector = data?.storage?.collector;
  if (Number.isFinite(collector?.lastSignalDbm)) {
    latestWifiSignal.set({
      signalDbm: collector.lastSignalDbm,
      interface: collector.lastInterface || null,
    });
  }
  if (!data?.notModified && Array.isArray(data?.samples)) {
    wifiSamples.set(data.samples);
  }
}

export async function syncWifiSamples(force = false) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      const data = await fetchWifiMap(force ? null : knownRevision);
      applyServerPayload(data);
      return data;
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

function syncWifiSamplesQuietly(force = false) {
  syncWifiSamples(force).catch(() => {});
}

async function migrateLegacySamples() {
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(LEGACY_SAMPLES_KEY);
  if (!raw) return;
  try {
    const samples = JSON.parse(raw);
    if (Array.isArray(samples) && samples.length) {
      await recordWifiSamples(samples.slice(-2000));
    }
    localStorage.removeItem(LEGACY_SAMPLES_KEY);
  } catch (_error) {
    // Keep the old data so migration can retry on the next page load.
  }
}

export function setWifiMapEnabled(enabled) {
  wifiMapEnabled.set(Boolean(enabled));
  if (enabled) syncWifiSamplesQuietly(true);
}

export function ingestWifiPose(pose) {
  const signalDbm = pose?.wifi?.signalDbm;
  if (!Number.isFinite(signalDbm)) return;
  latestWifiSignal.set(pose.wifi);
  if (!get(wifiMapEnabled) || !pose?.ok || recordInFlight) return;
  // The server collector owns recording by default; this remains a fallback for disabled collectors.
  if (get(wifiSurveyStorage).collector?.enabled !== false) return;

  const now = Date.now();
  const cellSizeM = get(wifiSurveyStorage).cellSizeM || 0.75;
  const cell = `${Math.round(pose.x / cellSizeM)},${Math.round(pose.y / cellSizeM)}`;
  const minimumInterval = cell === lastRecordCell ? STATIONARY_RECORD_MS : MIN_RECORD_MS;
  if (now - lastRecordAt < minimumInterval) return;

  const sample = { x: pose.x, y: pose.y, signalDbm, timestamp: now };
  lastRecordAt = now;
  lastRecordCell = cell;
  wifiSamples.update((samples) => mergeWifiSample(samples, sample, now));

  recordInFlight = true;
  recordWifiSamples([{ x: sample.x, y: sample.y, signalDbm: sample.signalDbm }])
    .catch(() => syncWifiSamplesQuietly(true))
    .finally(() => {
      recordInFlight = false;
    });
}

export async function clearWifiSamples() {
  const data = await deleteWifiMap();
  applyServerPayload({ ...data, samples: [] });
}

export function initWifiSurveyLifecycle() {
  if (typeof document === "undefined") return () => {};
  let timer = null;
  const syncIfVisible = () => {
    if (get(wifiMapEnabled) && !document.hidden) syncWifiSamplesQuietly();
  };

  migrateLegacySamples().finally(syncIfVisible);
  timer = setInterval(syncIfVisible, SYNC_MS);
  document.addEventListener("visibilitychange", syncIfVisible);
  return () => {
    if (timer != null) clearInterval(timer);
    document.removeEventListener("visibilitychange", syncIfVisible);
  };
}
