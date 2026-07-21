const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const yaml = require("js-yaml");

const app = express();
const port = process.env.PORT || 80;

// Defaults match the in-container mount points; overridable for local dev
// (e.g. PARAMS_PATH=./params/mower_params.yaml MAP_PATH=./ros/map.json).
const paramsPath = process.env.PARAMS_PATH || "/data/params/mower_params.yaml";
const mapPath = process.env.MAP_PATH || "/data/ros/map.json";
const mapDirectory = path.dirname(mapPath);
const wifiMapPath = process.env.WIFI_MAP_PATH || path.join(mapDirectory, "wifi-signal-map.json");
const wifiCellSizeM = Math.max(
  0.25,
  Math.min(5, Number(process.env.WIFI_MAP_CELL_SIZE_M) || 0.75)
);
const wifiMaxPoints = Math.max(
  100,
  Math.min(10000, Math.floor(Number(process.env.WIFI_MAP_MAX_POINTS) || 2000))
);
const wifiFlushMs = Math.max(
  10000,
  Math.min(300000, Math.floor(Number(process.env.WIFI_MAP_FLUSH_MS) || 30000))
);
const wifiCollectorIntervalMs = Math.max(
  5000,
  Math.min(300000, Math.floor(Number(process.env.WIFI_MAP_COLLECTOR_INTERVAL_MS) || 10000))
);
const wifiCollectorTfTimeoutSec = Math.max(
  1,
  Math.min(5, Math.floor(Number(process.env.WIFI_MAP_COLLECTOR_TF_TIMEOUT_SEC) || 2))
);
const wifiCollectorCellRevisitMs = Math.max(
  60000,
  Math.min(
    3600000,
    Math.floor(Number(process.env.WIFI_MAP_COLLECTOR_CELL_REVISIT_MS) || 300000)
  )
);
const wifiCollectorDisabled =
  String(process.env.WIFI_MAP_COLLECTOR_DISABLE || "").trim() === "1";
const distDir = path.join(__dirname, "dist");
const dockerSocketPath = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const restartContainerName = process.env.OPENMOWER_CONTAINER_NAME || "open_mower_ros";
const poseContainerName = process.env.OPENMOWER_POSE_CONTAINER || restartContainerName;
/** Keep ≥ client poll interval so one slow Docker exec can satisfy several polls (avoids ~15s gaps). */
const poseCacheMs = Math.max(200, Number(process.env.OPENMOWER_POSE_CACHE_MS) || 2200);
const poseDisabled = String(process.env.OPENMOWER_POSE_DISABLE || "").trim() === "1";
/** Cap per-attempt TF echo wait (fail fast between frame pairs). */
const tfEchoTimeoutSec = Math.max(
  2,
  Math.min(60, Math.floor(Number(process.env.OPENMOWER_TF_ECHO_TIMEOUT_SEC) || 4))
);
/** Per-topic `ros2 topic echo -n 1` / `rostopic echo` wait (ROS1 on Pi often needs several seconds). */
const rosTopicSampleTimeoutSec = Math.max(
  2,
  Math.min(15, Math.floor(Number(process.env.OPENMOWER_ROS_TOPIC_TIMEOUT_SEC) || 4))
);
/** If fast topic loop yields nothing, one longer `rostopic echo` on current_state only (ROS1). */
const rosTopicFallbackTimeoutSec = Math.max(
  rosTopicSampleTimeoutSec,
  Math.min(25, Math.floor(Number(process.env.OPENMOWER_ROS_TOPIC_FALLBACK_SEC) || 10))
);
/** Per-request HTTP + Docker API + routine file reads (default off to keep logs readable). */
const verboseLogs = String(process.env.OPENMOWER_VERBOSE_LOGS || "").trim() === "1";

function nowIso() {
  return new Date().toISOString();
}

function logInfo(message, meta = {}) {
  console.log(`[${nowIso()}] [INFO] ${message}`, meta);
}

function logWarn(message, meta = {}) {
  console.warn(`[${nowIso()}] [WARN] ${message}`, meta);
}

function logError(message, meta = {}) {
  console.error(`[${nowIso()}] [ERROR] ${message}`, meta);
}

const wifiSurvey = new Map();
let wifiSurveyLoaded = false;
let wifiSurveyLoadPromise = null;
let wifiSurveyDirty = false;
let wifiSurveyFlushTimer = null;
let wifiSurveyFlushPromise = null;
let wifiSurveyRevision = 0;
let wifiSurveyUpdatedAt = null;
let wifiSurveyLastBytes = 0;
let wifiCollectorTimer = null;
let wifiCollectorInFlight = false;
let wifiCollectorStopped = false;
let wifiCollectorSuccessCount = 0;
let wifiCollectorFailureCount = 0;
let wifiCollectorStoredCount = 0;
let wifiCollectorLastCollectedAt = null;
let wifiCollectorLastStoredAt = null;
let wifiCollectorLastSignalDbm = null;
let wifiCollectorLastInterface = null;
let wifiCollectorLastDurationMs = null;
let wifiCollectorLastError = null;

function wifiCellKey(x, y) {
  return `${Math.round(x / wifiCellSizeM)},${Math.round(y / wifiCellSizeM)}`;
}

function normalizeWifiSample(sample) {
  const x = Number(sample?.x);
  const y = Number(sample?.y);
  const signalDbm = Number(sample?.signalDbm);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(signalDbm) ||
    Math.abs(x) > 100000 ||
    Math.abs(y) > 100000 ||
    signalDbm < -120 ||
    signalDbm > 0
  ) {
    return null;
  }
  const key = wifiCellKey(x, y);
  const [cellX, cellY] = key.split(",").map(Number);
  return {
    key,
    x: Number((cellX * wifiCellSizeM).toFixed(3)),
    y: Number((cellY * wifiCellSizeM).toFixed(3)),
    signalDbm,
    timestamp: Date.now(),
  };
}

function evictOldestWifiSample() {
  let oldestKey = null;
  let oldestTimestamp = Infinity;
  for (const [key, sample] of wifiSurvey) {
    if (sample.timestamp < oldestTimestamp) {
      oldestKey = key;
      oldestTimestamp = sample.timestamp;
    }
  }
  if (oldestKey != null) wifiSurvey.delete(oldestKey);
}

function mergeWifiSurveySample(input, markDirty = true) {
  const sample = normalizeWifiSample(input);
  if (!sample) return false;
  const previous = wifiSurvey.get(sample.key);
  if (previous) {
    const weight = Math.min(Math.max(previous.samples || 1, 1), 9);
    previous.signalDbm = Number(
      ((previous.signalDbm * weight + sample.signalDbm) / (weight + 1)).toFixed(1)
    );
    previous.samples = Math.min((previous.samples || 1) + 1, 1000000);
    previous.timestamp = sample.timestamp;
  } else {
    if (wifiSurvey.size >= wifiMaxPoints) evictOldestWifiSample();
    wifiSurvey.set(sample.key, {
      x: sample.x,
      y: sample.y,
      signalDbm: Number(sample.signalDbm.toFixed(1)),
      samples: 1,
      timestamp: sample.timestamp,
    });
  }
  if (markDirty) {
    wifiSurveyDirty = true;
    wifiSurveyRevision += 1;
    wifiSurveyUpdatedAt = Date.now();
    scheduleWifiSurveyFlush();
  }
  return true;
}

async function ensureWifiSurveyLoaded() {
  if (wifiSurveyLoaded) return;
  if (wifiSurveyLoadPromise) return wifiSurveyLoadPromise;
  wifiSurveyLoadPromise = (async () => {
    try {
      const content = await fs.readFile(wifiMapPath, "utf8");
      wifiSurveyLastBytes = Buffer.byteLength(content, "utf8");
      const parsed = JSON.parse(content);
      const samples = Array.isArray(parsed?.samples) ? parsed.samples.slice(-wifiMaxPoints) : [];
      for (const sample of samples) {
        const normalized = normalizeWifiSample(sample);
        if (!normalized) continue;
        const timestamp = Number(sample.timestamp);
        const sampleCount = Number(sample.samples);
        wifiSurvey.set(normalized.key, {
          x: normalized.x,
          y: normalized.y,
          signalDbm: Number(normalized.signalDbm.toFixed(1)),
          samples: Number.isFinite(sampleCount)
            ? Math.max(1, Math.min(1000000, Math.floor(sampleCount)))
            : 1,
          timestamp: Number.isFinite(timestamp) ? timestamp : normalized.timestamp,
        });
      }
      wifiSurveyUpdatedAt = Number(parsed?.updatedAt) || null;
      wifiSurveyRevision = 1;
      logInfo("Loaded central WiFi survey", {
        file: wifiMapPath,
        points: wifiSurvey.size,
        bytes: wifiSurveyLastBytes,
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        logWarn("Failed to load central WiFi survey; starting empty", {
          file: wifiMapPath,
          error: error.message,
        });
      }
    } finally {
      wifiSurveyLoaded = true;
      wifiSurveyLoadPromise = null;
    }
  })();
  return wifiSurveyLoadPromise;
}

function wifiSurveyPayload() {
  return {
    version: 1,
    cellSizeM: wifiCellSizeM,
    maxPoints: wifiMaxPoints,
    updatedAt: wifiSurveyUpdatedAt,
    samples: [...wifiSurvey.values()],
  };
}

async function applyMowerFileOwnership(filePath) {
  for (const ownerPath of [wifiMapPath, mapPath, mapDirectory]) {
    try {
      const owner = await fs.stat(ownerPath);
      await fs.chown(filePath, owner.uid, owner.gid);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EPERM") throw error;
    }
  }
  await fs.chmod(filePath, 0o664);
}

async function flushWifiSurvey(forceAll = false) {
  if (wifiSurveyFlushTimer) {
    clearTimeout(wifiSurveyFlushTimer);
    wifiSurveyFlushTimer = null;
  }
  if (wifiSurveyFlushPromise) {
    await wifiSurveyFlushPromise;
    if (forceAll && wifiSurveyDirty) return flushWifiSurvey(true);
    return;
  }
  if (!wifiSurveyLoaded || !wifiSurveyDirty) return;
  const flushRevision = wifiSurveyRevision;
  wifiSurveyFlushPromise = (async () => {
    const payload = JSON.stringify(wifiSurveyPayload());
    const temporaryPath = `${wifiMapPath}.tmp`;
    await fs.mkdir(path.dirname(wifiMapPath), { recursive: true });
    await fs.writeFile(temporaryPath, payload, "utf8");
    await applyMowerFileOwnership(temporaryPath);
    await fs.rename(temporaryPath, wifiMapPath);
    wifiSurveyLastBytes = Buffer.byteLength(payload, "utf8");
    wifiSurveyDirty = wifiSurveyRevision !== flushRevision;
    logInfo("Flushed central WiFi survey", {
      file: wifiMapPath,
      points: wifiSurvey.size,
      bytes: wifiSurveyLastBytes,
    });
  })();
  try {
    await wifiSurveyFlushPromise;
  } finally {
    wifiSurveyFlushPromise = null;
  }
  if (wifiSurveyDirty) {
    if (forceAll) return flushWifiSurvey(true);
    scheduleWifiSurveyFlush();
  }
}

function scheduleWifiSurveyFlush() {
  if (wifiSurveyFlushTimer) return;
  wifiSurveyFlushTimer = setTimeout(() => {
    flushWifiSurvey().catch((error) => {
      logError("Failed to flush central WiFi survey", {
        file: wifiMapPath,
        error: error.message,
      });
      if (wifiSurveyDirty) scheduleWifiSurveyFlush();
    });
  }, wifiFlushMs);
  wifiSurveyFlushTimer.unref?.();
}

function wifiSurveyMeta() {
  return {
    revision: wifiSurveyRevision,
    sampleCount: wifiSurvey.size,
    updatedAt: wifiSurveyUpdatedAt,
    storage: {
      central: true,
      cellSizeM: wifiCellSizeM,
      maxPoints: wifiMaxPoints,
      flushIntervalMs: wifiFlushMs,
      fileBytes: wifiSurveyLastBytes,
      collector: {
        enabled: !wifiCollectorDisabled && !poseDisabled,
        intervalMs: wifiCollectorIntervalMs,
        tfTimeoutSec: wifiCollectorTfTimeoutSec,
        cellRevisitMs: wifiCollectorCellRevisitMs,
        inFlight: wifiCollectorInFlight,
        successCount: wifiCollectorSuccessCount,
        failureCount: wifiCollectorFailureCount,
        storedCount: wifiCollectorStoredCount,
        lastCollectedAt: wifiCollectorLastCollectedAt,
        lastStoredAt: wifiCollectorLastStoredAt,
        lastSignalDbm: wifiCollectorLastSignalDbm,
        lastInterface: wifiCollectorLastInterface,
        lastDurationMs: wifiCollectorLastDurationMs,
        lastError: wifiCollectorLastError,
      },
    },
  };
}

app.use(express.json({ limit: "20mb" }));
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (!verboseLogs) {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on("finish", () => {
    logInfo("HTTP request finished", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

function shouldRestartFromQuery(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function extractGpsDatum(data) {
  const datumLat = data?.ll?.services?.gps?.datum_lat;
  const datumLng = data?.ll?.services?.gps?.datum_long;
  if (!Number.isFinite(datumLat) || !Number.isFinite(datumLng)) {
    return null;
  }
  return { datumLat, datumLng };
}

function isValidMapFileName(fileName) {
  return (
    typeof fileName === "string" &&
    (fileName === "map.json" || fileName.startsWith("map.json.bak-")) &&
    fileName === path.basename(fileName)
  );
}

function dockerApiRequest(method, requestPath, requestBody = null, options = {}) {
  const binaryBody = Boolean(options.binaryBody);
  return new Promise((resolve, reject) => {
    const payload =
      requestBody == null ? null : Buffer.from(JSON.stringify(requestBody), "utf8");
    const headers = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    if (verboseLogs) {
      logInfo("Docker API request", {
        method,
        requestPath,
        hasBody: Boolean(payload),
        binaryBody,
      });
    }
    const req = http.request(
      {
        socketPath: dockerSocketPath,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        if (binaryBody) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks) });
          });
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 0, body });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Reads tf_echo / tf2_echo stdout on stdin; prints "x y yaw" for bash wrapper. No ROS Python deps. */
const ROBOT_TF_PARSE_PY = `import math
import re
import sys

text = sys.stdin.read()
mt = re.search(r"Translation:\\s*\\[\\s*([-+\\d.eE]+)\\s*,\\s*([-+\\d.eE]+)", text)
if not mt:
    sys.exit(1)
x, y = float(mt.group(1)), float(mt.group(2))
mq = re.search(
    r"Quaternion[^\\[]*\\[\\s*([-+\\d.eE]+)\\s*,\\s*([-+\\d.eE]+)\\s*,\\s*([-+\\d.eE]+)\\s*,\\s*([-+\\d.eE]+)\\s*\\]",
    text,
)
yaw = 0.0
if mq:
    qx, qy, qz, qw = map(float, mq.groups())
    siny_cosp = 2 * (qw * qz + qx * qy)
    cosy_cosp = 1 - 2 * (qy * qy + qz * qz)
    yaw = math.atan2(siny_cosp, cosy_cosp)
print("{:.6f} {:.6f} {:.6f}".format(x, y, yaw))
`;

function buildRobotPoseProbeBash() {
  const b64 = Buffer.from(ROBOT_TF_PARSE_PY, "utf8").toString("base64");
  return [
    "set +e",
    `echo '${b64}' | base64 -d > /tmp/om_parse_tf.py`,
    "for SETUP in /opt/ros/humble/setup.bash /opt/ros/jazzy/setup.bash /opt/ros/iron/setup.bash /opt/ros/noetic/setup.bash; do",
    '  [ -f "$SETUP" ] || continue',
    '  # shellcheck disable=SC1090',
    '  . "$SETUP"',
    "  break",
    "done",
    "for WS in /opt/open_mower_ros/devel/setup.bash /ros_ws/install/setup.bash /workspace/install/setup.bash /colcon_ws/install/setup.bash /catkin_ws/devel/setup.bash /open_mower/install/setup.bash; do",
    '  [ -f "$WS" ] || continue',
    '  # shellcheck disable=SC1090',
    '  . "$WS"',
    "  break",
    "done",
    "if command -v ros2 >/dev/null 2>&1; then",
    `  run_tf() { timeout ${tfEchoTimeoutSec} ros2 run tf2_ros tf2_echo "$1" "$2" 2>/dev/null; }`,
    "elif command -v rosrun >/dev/null 2>&1; then",
    `  run_tf() { timeout ${tfEchoTimeoutSec} rosrun tf tf_echo "$1" "$2" 2>/dev/null; }`,
    "else",
    '  echo "ERR no ros2 or rosrun in PATH after sourcing /opt/ros"',
    "  exit 1",
    "fi",
    "sample_extra() {",
    "  local out t",
    "  t=$1",
    `  out=$(timeout ${rosTopicSampleTimeoutSec} ros2 topic echo -n 1 "$t" 2>/dev/null | head -n 48)`,
    '  [ -z "$out" ] && return 1',
    '  case "$t" in *emergency*)',
    '    echo "$out" | grep -qi "active_emergency: false" && echo "$out" | grep -qi "latched_emergency: false" && return 1',
    "    ;;",
    "  esac",
    "  echo EXTRA_BEGIN",
    '  echo "topic:$t"',
    '  echo "$out"',
    "  echo EXTRA_END",
    "  return 0",
    "}",
    "sample_extra_ros1() {",
    "  local out t",
    "  t=$1",
    `  out=$(timeout ${rosTopicSampleTimeoutSec} rostopic echo -n 1 "$t" 2>/dev/null | head -n 48)`,
    '  [ -z "$out" ] && return 1',
    '  case "$t" in *emergency*)',
    '    echo "$out" | grep -qi "active_emergency: false" && echo "$out" | grep -qi "latched_emergency: false" && return 1',
    "    ;;",
    "  esac",
    "  echo EXTRA_BEGIN",
    '  echo "topic:${t#/}"',
    '  echo "$out"',
    "  echo EXTRA_END",
    "  return 0",
    "}",
    'for parent in map odom; do',
    '  for child in base_link base_footprint; do',
    "    parsed=$(run_tf \"$parent\" \"$child\" | head -n 45 | python3 /tmp/om_parse_tf.py) || continue",
    '    echo "OK $parsed $parent $child"',
    "    ros_extra_sampled=0",
    "    if command -v rostopic >/dev/null 2>&1; then",
    '      for t in /mower_logic/current_state /ll/emergency /ll/mower_status; do',
    "        if sample_extra_ros1 \"$t\"; then ros_extra_sampled=1; break; fi",
    "      done",
    "    fi",
    "    if [ \"$ros_extra_sampled\" != 1 ] && command -v rostopic >/dev/null 2>&1; then",
    `      out=$(timeout ${rosTopicFallbackTimeoutSec} rostopic echo -n 1 /mower_logic/current_state 2>/dev/null | head -n 48)`,
    '      if [ -n "$out" ]; then',
    "        echo EXTRA_BEGIN",
    '        echo "topic:mower_logic/current_state"',
    '        echo "$out"',
    "        echo EXTRA_END",
    "        ros_extra_sampled=1",
    "      fi",
    "    fi",
    "    if [ \"$ros_extra_sampled\" != 1 ] && command -v ros2 >/dev/null 2>&1; then",
    '      for tt in mower_logic/current_state ll/emergency ll/mower_status; do',
    '        t="${tt#/}"',
    "        if sample_extra \"$t\"; then break; fi",
    "      done",
    "    fi",
    "    echo WIFI_BEGIN",
    "    cat /proc/net/wireless 2>/dev/null",
    "    echo WIFI_END",
    "    exit 0",
    "  done",
    "done",
    'echo "ERR no TF transform (tried map/odom -> base_link/base_footprint)"',
    "exit 1",
  ].join("\n");
}

function buildWifiCollectorProbeBash() {
  const b64 = Buffer.from(ROBOT_TF_PARSE_PY, "utf8").toString("base64");
  return [
    "set +e",
    "for SETUP in /opt/ros/humble/setup.bash /opt/ros/jazzy/setup.bash /opt/ros/iron/setup.bash /opt/ros/noetic/setup.bash; do",
    '  [ -f "$SETUP" ] || continue',
    '  . "$SETUP"',
    "  break",
    "done",
    "for WS in /opt/open_mower_ros/devel/setup.bash /ros_ws/install/setup.bash /workspace/install/setup.bash /colcon_ws/install/setup.bash /catkin_ws/devel/setup.bash /open_mower/install/setup.bash; do",
    '  [ -f "$WS" ] || continue',
    '  . "$WS"',
    "  break",
    "done",
    "if command -v ros2 >/dev/null 2>&1; then",
    `  run_tf() { timeout ${wifiCollectorTfTimeoutSec} ros2 run tf2_ros tf2_echo map "$1" 2>/dev/null; }`,
    "elif command -v rosrun >/dev/null 2>&1; then",
    `  run_tf() { timeout ${wifiCollectorTfTimeoutSec} rosrun tf tf_echo map "$1" 2>/dev/null; }`,
    "else",
    '  echo "ERR no ros2 or rosrun in PATH after sourcing /opt/ros"',
    "  exit 1",
    "fi",
    "for child in base_link base_footprint; do",
    `  parsed=$(run_tf "$child" | head -n 20 | python3 <(echo '${b64}' | base64 -d)) || continue`,
    '  echo "OK $parsed map $child"',
    "  echo WIFI_BEGIN",
    "  cat /proc/net/wireless 2>/dev/null",
    "  echo WIFI_END",
    "  exit 0",
    "done",
    'echo "ERR no TF transform (tried map -> base_link/base_footprint)"',
    "exit 1",
  ].join("\n");
}

let robotPoseCache = {
  expiresAt: 0,
  payload: null,
};
let robotPosePromise = null;

/** Parse rostopic echo text (YAML-ish) for map HUD / tooltips. Percents normalized to 0–100. */
function extractRosTelemetry(topic, raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return null;
  }
  const t = (topic || "").toLowerCase();
  const pickNum = (key) => {
    const m = trimmed.match(new RegExp(`^${key}:\\s*([-+0-9.eE]+)`, "im"));
    if (!m) {
      return null;
    }
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const pickBool = (key) => {
    const m = trimmed.match(
      new RegExp(`^${key}:\\s*(True|False|true|false|0|1)(?:\\s|$)`, "im")
    );
    if (!m) {
      return null;
    }
    const v = m[1].toLowerCase();
    return v === "true" || v === "1";
  };
  const pickQuoted = (key) => {
    const m = trimmed.match(new RegExp(`^${key}:\\s*"([^"]*)"`, "im"));
    return m ? m[1].trim() : null;
  };

  const out = {};

  if (t.includes("mower_logic") || /state_name:/m.test(trimmed)) {
    const sn = pickQuoted("state_name");
    if (sn) {
      out.stateName = sn;
    }
    const sub = pickQuoted("sub_state_name");
    if (sub) {
      out.subStateName = sub;
    }
    let bat = pickNum("battery_percent");
    if (bat != null && bat >= 0 && bat <= 1.05) {
      bat *= 100;
    }
    if (bat != null && bat >= 0 && bat <= 100) {
      out.batteryPercent = bat;
    }
    let gps = pickNum("gps_quality_percent");
    if (gps != null && gps >= 0 && gps <= 1.05) {
      gps *= 100;
    }
    if (gps != null && gps >= 0 && gps <= 100) {
      out.gpsQualityPercent = gps;
    }
    const ch = pickBool("is_charging");
    if (ch != null) {
      out.isCharging = ch;
    }
    const em = pickBool("emergency");
    if (em != null) {
      out.emergency = em;
    }
    const st = pickNum("state");
    if (st != null) {
      out.stateCode = st;
    }
  }

  if (t.includes("emergency") || /active_emergency:/m.test(trimmed)) {
    const ae = pickBool("active_emergency");
    if (ae != null) {
      out.activeEmergency = ae;
    }
    const le = pickBool("latched_emergency");
    if (le != null) {
      out.latchedEmergency = le;
    }
    const r =
      trimmed.match(/^reason:\s*'([^']*)'/im) || trimmed.match(/^reason:\s*"([^"]*)"/im);
    if (r && r[1].trim()) {
      out.emergencyReason = r[1].trim();
    }
  }

  if (t.includes("mower_status") || /mower_esc_temperature:/m.test(trimmed)) {
    const ch = pickBool("is_charging");
    if (ch != null) {
      out.isCharging = ch;
    }
    const me = pickBool("mow_enabled");
    if (me != null) {
      out.mowEnabled = me;
    }
    const rd = pickBool("rain_detected");
    if (rd != null) {
      out.rainDetected = rd;
    }
    const escT = pickNum("mower_esc_temperature");
    if (escT != null && escT >= -40 && escT < 120) {
      out.escTempC = escT;
    }
    const rpm = pickNum("mower_motor_rpm");
    if (rpm != null) {
      out.mowerMotorRpm = rpm;
    }
  }

  return Object.keys(out).length ? out : null;
}

/** Drives map icon: nav / docking / dock charging / dock full / emergency / error */
function computeRosVisualMode(health, telemetry) {
  if (health === "emergency") {
    return "emergency";
  }
  if (health === "error") {
    return "error";
  }
  const stateRaw = String(telemetry?.stateName ?? "");
  const stateUp = stateRaw.toUpperCase().replace(/\s+/g, "_");

  const docking =
    /(GOING_TO_DOCK|RETURN_TO_DOCK|NAV_TO_DOCK|DOCKING|APPROACH_DOCK|DOCK_NAV|FIND_DOCK|SEARCH_DOCK|TO_DOCK)/i.test(
      stateRaw
    ) && !/UNDOCK/i.test(stateRaw);

  if (docking) {
    return "docking";
  }

  if (telemetry?.isCharging === true) {
    return "dock_charging";
  }

  const bat = telemetry?.batteryPercent;
  if (
    telemetry?.isCharging === false &&
    Number.isFinite(bat) &&
    bat >= 88 &&
    /CHARGING_COMPLETE|DOCKED|AT_DOCK|FULL|STANDBY_DOCK|IDLE_DOCK|PARK_DOCK/i.test(stateUp)
  ) {
    return "dock_full";
  }

  return "nav";
}

function summarizeRosSnippet(topic, raw) {
  const trimmed = (raw || "").trim();
  const firstLine = trimmed.split(/\r?\n/).find((l) => l.trim()) || "";
  let health = "unknown";
  let summary = topic ? `Topic: ${topic}` : "ROS status";
  const blob = `${trimmed}\n${topic || ""}`.toLowerCase();
  const telemetry = extractRosTelemetry(topic, trimmed);

  const stateNameQuoted = trimmed.match(/state_name:\s*"([^"]*)"/);
  const stateNameVal = (stateNameQuoted?.[1] ?? "").trim();
  const reasonQuoted =
    trimmed.match(/reason:\s*'([^']*)'/) || trimmed.match(/reason:\s*"([^"]*)"/);
  const reasonVal = (reasonQuoted?.[1] ?? "").trim();

  const activeEmerg = /active_emergency:\s*true/i.test(trimmed);
  const latchedEmerg = /latched_emergency:\s*true/i.test(trimmed);
  const highLevelEmerg = /\bemergency:\s*true\b/i.test(trimmed);

  if (activeEmerg || latchedEmerg || highLevelEmerg) {
    health = "emergency";
    const parts = [];
    if (activeEmerg && latchedEmerg) {
      parts.push("Emergency (active + latched)");
    } else if (activeEmerg) {
      parts.push("Emergency (active)");
    } else if (latchedEmerg) {
      parts.push("Latched emergency");
    } else {
      parts.push("Emergency");
    }
    if (stateNameVal) {
      parts.push(stateNameVal);
    }
    if (reasonVal) {
      parts.push(`Reason: ${reasonVal}`);
    }
    summary = parts.join(" · ");
    return {
      topic: topic || null,
      summary,
      health,
      telemetry,
      visualMode: computeRosVisualMode(health, telemetry),
      rawSample: trimmed.slice(0, 420),
    };
  }

  if (/error|fault|stuck|fail/.test(blob)) {
    health = "error";
    summary = "Fault / error in status message";
  } else if (/\bis_charging:\s*true\b/i.test(trimmed)) {
    health = "charging";
    summary = "Charging";
  } else if (/mow|mowing|cut|coverage|idle|pause|driving|nav/.test(blob)) {
    health = "ok";
    summary = firstLine.slice(0, 100) || summary;
  } else if (trimmed) {
    summary = firstLine.slice(0, 100) || summary;
  }

  if (telemetry?.isCharging === true && health !== "emergency" && health !== "error") {
    health = "charging";
  }

  return {
    topic: topic || null,
    summary,
    health,
    telemetry,
    visualMode: computeRosVisualMode(health, telemetry),
    rawSample: trimmed.slice(0, 420),
  };
}

function parseRobotProbeOutput(text) {
  const full = text.trim();
  if (!full) {
    return { ok: false, error: "Empty response from pose probe", liveRobotFatal: false, ros: null };
  }
  const lines = full.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let ros = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "EXTRA_BEGIN") {
      const endIdx = lines.indexOf("EXTRA_END", i + 1);
      if (endIdx > i) {
        const chunkLines = lines.slice(i + 1, endIdx);
        const topicLine = chunkLines.find((l) => l.startsWith("topic:"));
        const topic = topicLine ? topicLine.slice(6).trim() : null;
        const dataLines = chunkLines.filter((l) => !l.startsWith("topic:"));
        const raw = dataLines.join("\n");
        ros = summarizeRosSnippet(topic, raw);
      }
      break;
    }
  }

  let wifi = null;
  const wifiBegin = lines.indexOf("WIFI_BEGIN");
  const wifiEnd = lines.indexOf("WIFI_END", wifiBegin + 1);
  if (wifiBegin >= 0 && wifiEnd > wifiBegin) {
    for (const line of lines.slice(wifiBegin + 1, wifiEnd)) {
      const match = line.match(/^([^:\s]+):\s+\S+\s+([-+\d.]+)\s+([-+\d.]+)/);
      if (!match) continue;
      const linkQuality = Number(match[2]);
      const signalDbm = Number(match[3]);
      if (!Number.isFinite(signalDbm)) continue;
      const percent = Math.max(0, Math.min(100, Math.round((signalDbm + 100) * 2)));
      wifi = {
        interface: match[1],
        signalDbm,
        linkQuality: Number.isFinite(linkQuality) ? linkQuality : null,
        linkQualityMax: 70,
        percent,
      };
      break;
    }
  }

  const okLine = [...lines].reverse().find((l) => l.startsWith("OK "));
  const errLine = lines.find((l) => l.startsWith("ERR "));

  if (okLine) {
    const parts = okLine.slice(3).trim().split(/\s+/);
    if (parts.length < 5) {
      return {
        ok: false,
        error: "Malformed pose line",
        liveRobotFatal: false,
        ros,
      };
    }
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const yaw = Number(parts[2]);
    const parentFrame = parts[3];
    const childFrame = parts[4];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
      return {
        ok: false,
        error: "Non-numeric pose fields",
        liveRobotFatal: false,
        ros,
      };
    }
    return {
      ok: true,
      x,
      y,
      yaw,
      frameParent: parentFrame,
      frameChild: childFrame,
      units: "meters_map_frame",
      ros,
      wifi,
      liveRobotFatal: false,
    };
  }

  if (errLine) {
    return {
      ok: false,
      error: errLine.slice(4).trim() || "Unknown TF error",
      liveRobotFatal: false,
      ros,
    };
  }

  return {
    ok: false,
    error: full.slice(0, 200),
    liveRobotFatal: false,
    ros,
  };
}

async function dockerExecInContainer(container, cmd, env = []) {
  const create = await dockerApiRequest(
    "POST",
    `/containers/${encodeURIComponent(container)}/exec`,
    {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: env,
      Cmd: cmd,
    }
  );
  if (create.statusCode < 200 || create.statusCode >= 300) {
    let detail = create.body;
    try {
      const parsed = JSON.parse(create.body);
      if (parsed?.message) detail = parsed.message;
    } catch (_e) {
      /* keep body string */
    }
    throw new Error(`exec create failed (${create.statusCode}): ${detail}`);
  }
  let execId;
  try {
    execId = JSON.parse(create.body).Id;
  } catch (_e) {
    throw new Error("exec create returned invalid JSON");
  }
  if (!execId) {
    throw new Error("exec create missing Id");
  }

  const start = await dockerApiRequest(
    "POST",
    `/exec/${execId}/start`,
    {
      Detach: false,
      Tty: false,
    },
    { binaryBody: true }
  );
  if (start.statusCode < 200 || start.statusCode >= 300) {
    const errText =
      Buffer.isBuffer(start.body) ? start.body.toString("utf8") : String(start.body);
    throw new Error(`exec start failed (${start.statusCode}): ${errText}`);
  }

  return demuxDockerStream(start.body);
}

function demuxDockerStream(raw) {
  if (!Buffer.isBuffer(raw)) {
    return { stdout: String(raw || ""), stderr: "" };
  }
  let stdoutChunks = [];
  let stderrChunks = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const streamType = raw.readUInt8(offset);
    const len = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > raw.length) break;
    const chunk = raw.subarray(start, end);
    if (streamType === 1) stdoutChunks.push(chunk);
    else if (streamType === 2) stderrChunks.push(chunk);
    offset = end;
  }
  if (stdoutChunks.length === 0 && stderrChunks.length === 0 && raw.length) {
    return { stdout: raw.toString("utf8"), stderr: "" };
  }
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

async function inspectPoseContainer() {
  const r = await dockerApiRequest(
    "GET",
    `/containers/${encodeURIComponent(poseContainerName)}/json`
  );
  if (r.statusCode === 404) {
    let msg = `No such container: ${poseContainerName}`;
    try {
      const parsed = JSON.parse(r.body);
      if (parsed?.message) msg = parsed.message;
    } catch (_e) {
      /* keep default */
    }
    return {
      ok: false,
      error: msg,
      container: {
        name: poseContainerName,
        exists: false,
        running: false,
        status: "missing",
      },
    };
  }
  if (r.statusCode < 200 || r.statusCode >= 300) {
    return {
      ok: false,
      error: `docker inspect failed (${r.statusCode})`,
      container: {
        name: poseContainerName,
        exists: null,
        running: false,
        status: "unknown",
      },
    };
  }
  let j;
  try {
    j = JSON.parse(r.body);
  } catch (_e) {
    return {
      ok: false,
      error: "docker inspect returned invalid JSON",
      container: null,
    };
  }
  const running = j.State?.Running === true;
  const status = j.State?.Status || "unknown";
  return {
    ok: true,
    container: {
      name: poseContainerName,
      exists: true,
      running,
      status,
      restartCount: j.RestartCount ?? 0,
      startedAt: j.State?.StartedAt || null,
    },
  };
}

async function fetchRobotPoseFromRosContainer() {
  if (poseDisabled) {
    return {
      ok: false,
      error: "Robot pose disabled via OPENMOWER_POSE_DISABLE=1",
      liveRobotFatal: true,
      ros: null,
    };
  }
  const bashCmd = buildRobotPoseProbeBash();
  const { stdout, stderr } = await dockerExecInContainer(poseContainerName, [
    "/bin/bash",
    "-lc",
    bashCmd,
  ]);
  const trimmedErr = stderr.trim();
  if (trimmedErr) {
    logWarn("Robot pose stderr", { container: poseContainerName, stderr: trimmedErr });
  }
  return parseRobotProbeOutput(stdout || stderr || "");
}

async function collectAutonomousWifiSample() {
  const startedAt = Date.now();
  const { stdout, stderr } = await dockerExecInContainer(poseContainerName, [
    "/bin/bash",
    "-lc",
    buildWifiCollectorProbeBash(),
  ]);
  const probe = parseRobotProbeOutput(stdout || stderr || "");
  if (
    !probe.ok ||
    probe.frameParent !== "map" ||
    !Number.isFinite(probe.x) ||
    !Number.isFinite(probe.y) ||
    !Number.isFinite(probe.wifi?.signalDbm)
  ) {
    throw new Error(probe.error || "WiFi collector probe returned no map pose or signal");
  }

  await ensureWifiSurveyLoaded();
  const now = Date.now();
  const key = wifiCellKey(probe.x, probe.y);
  const previous = wifiSurvey.get(key);
  const previousAgeMs = previous ? now - Number(previous.timestamp || 0) : Infinity;
  const signalChangeDbm = previous
    ? Math.abs(Number(previous.signalDbm) - probe.wifi.signalDbm)
    : Infinity;
  const shouldStore =
    !previous ||
    (previousAgeMs >= wifiCollectorCellRevisitMs && signalChangeDbm >= 3);

  wifiCollectorSuccessCount += 1;
  wifiCollectorLastCollectedAt = now;
  wifiCollectorLastSignalDbm = probe.wifi.signalDbm;
  wifiCollectorLastInterface = probe.wifi.interface || null;
  wifiCollectorLastDurationMs = now - startedAt;
  wifiCollectorLastError = null;

  if (
    shouldStore &&
    mergeWifiSurveySample({
      x: probe.x,
      y: probe.y,
      signalDbm: probe.wifi.signalDbm,
    })
  ) {
    wifiCollectorStoredCount += 1;
    wifiCollectorLastStoredAt = Date.now();
    return true;
  }
  return false;
}

function scheduleAutonomousWifiCollector(delayMs = wifiCollectorIntervalMs) {
  if (wifiCollectorDisabled || poseDisabled || wifiCollectorStopped || wifiCollectorTimer) return;
  wifiCollectorTimer = setTimeout(async () => {
    wifiCollectorTimer = null;
    if (wifiCollectorInFlight) {
      scheduleAutonomousWifiCollector();
      return;
    }
    wifiCollectorInFlight = true;
    const startedAt = Date.now();
    try {
      await collectAutonomousWifiSample();
    } catch (error) {
      wifiCollectorFailureCount += 1;
      wifiCollectorLastDurationMs = Date.now() - startedAt;
      wifiCollectorLastError = error.message || "WiFi collector failed";
      if (wifiCollectorFailureCount === 1 || wifiCollectorFailureCount % 30 === 0) {
        logWarn("Autonomous WiFi collector failed", {
          failures: wifiCollectorFailureCount,
          error: wifiCollectorLastError,
        });
      }
    } finally {
      wifiCollectorInFlight = false;
      const elapsedMs = Date.now() - startedAt;
      scheduleAutonomousWifiCollector(Math.max(1000, wifiCollectorIntervalMs - elapsedMs));
    }
  }, delayMs);
  wifiCollectorTimer.unref?.();
}

function startAutonomousWifiCollector() {
  if (wifiCollectorDisabled || poseDisabled) {
    logInfo("Autonomous WiFi collector disabled", {
      wifiCollectorDisabled,
      poseDisabled,
    });
    return;
  }
  wifiCollectorStopped = false;
  logInfo("Autonomous WiFi collector enabled", {
    intervalMs: wifiCollectorIntervalMs,
    tfTimeoutSec: wifiCollectorTfTimeoutSec,
    cellRevisitMs: wifiCollectorCellRevisitMs,
  });
  scheduleAutonomousWifiCollector(1500);
}

function stopAutonomousWifiCollector() {
  wifiCollectorStopped = true;
  if (!wifiCollectorTimer) return;
  clearTimeout(wifiCollectorTimer);
  wifiCollectorTimer = null;
}

async function getRobotPoseCached() {
  const now = Date.now();
  if (robotPoseCache.payload && robotPoseCache.expiresAt > now) {
    return { ...robotPoseCache.payload, cached: true };
  }
  if (robotPosePromise) {
    return robotPosePromise;
  }
  robotPosePromise = (async () => {
    try {
      if (poseDisabled) {
        const payload = {
          ok: false,
          error: "Robot pose disabled via OPENMOWER_POSE_DISABLE=1",
          liveRobotFatal: true,
          container: null,
          ros: null,
        };
        robotPoseCache = {
          expiresAt: Date.now() + poseCacheMs,
          payload,
        };
        return { ...payload, cached: false };
      }

      const inspect = await inspectPoseContainer();
      if (!inspect.ok) {
        const payload = {
          ok: false,
          error: inspect.error,
          container: inspect.container,
          ros: null,
          liveRobotFatal: true,
        };
        robotPoseCache = {
          expiresAt: Date.now() + Math.min(poseCacheMs, 2000),
          payload,
        };
        return { ...payload, cached: false };
      }
      if (!inspect.container.running) {
        const payload = {
          ok: false,
          error: `Container '${poseContainerName}' is not running (${inspect.container.status})`,
          container: inspect.container,
          ros: null,
          liveRobotFatal: true,
        };
        robotPoseCache = {
          expiresAt: Date.now() + Math.min(poseCacheMs, 2000),
          payload,
        };
        return { ...payload, cached: false };
      }

      let posePayload;
      try {
        posePayload = await fetchRobotPoseFromRosContainer();
      } catch (error) {
        const payload = {
          ok: false,
          error: error.message || "Docker exec failed (is the socket mounted?)",
          container: inspect.container,
          ros: null,
          liveRobotFatal: true,
        };
        robotPoseCache = {
          expiresAt: Date.now() + Math.min(poseCacheMs, 2000),
          payload,
        };
        logWarn("Robot pose exec failed", {
          container: poseContainerName,
          error: error.message,
        });
        return { ...payload, cached: false };
      }

      const payload = {
        ...posePayload,
        container: inspect.container,
        liveRobotFatal: posePayload.liveRobotFatal === true,
      };
      robotPoseCache = {
        expiresAt: Date.now() + poseCacheMs,
        payload,
      };
      return { ...payload, cached: false };
    } catch (error) {
      const payload = {
        ok: false,
        error: error.message || "Robot pose request failed",
        container: null,
        ros: null,
        liveRobotFatal: true,
      };
      robotPoseCache = {
        expiresAt: Date.now() + Math.min(poseCacheMs, 2000),
        payload,
      };
      logWarn("Robot pose request failed", {
        container: poseContainerName,
        error: error.message,
      });
      return { ...payload, cached: false };
    } finally {
      robotPosePromise = null;
    }
  })();
  return robotPosePromise;
}

async function restartOpenMowerContainer() {
  logInfo("Restart requested for container", { container: restartContainerName });
  const inspect = await dockerApiRequest(
    "GET",
    `/containers/${encodeURIComponent(restartContainerName)}/json`
  );
  if (inspect.statusCode === 404) {
    logWarn("Restart skipped: container not found", { container: restartContainerName });
    return {
      restarted: false,
      reason: `Container '${restartContainerName}' not found`,
    };
  }
  if (inspect.statusCode < 200 || inspect.statusCode >= 300) {
    logWarn("Restart skipped: docker inspect failed", {
      container: restartContainerName,
      statusCode: inspect.statusCode,
    });
    return {
      restarted: false,
      reason: `Docker inspect failed with status ${inspect.statusCode}`,
    };
  }

  const restart = await dockerApiRequest(
    "POST",
    `/containers/${encodeURIComponent(restartContainerName)}/restart`
  );
  if (restart.statusCode < 200 || restart.statusCode >= 299) {
    logWarn("Restart failed", {
      container: restartContainerName,
      statusCode: restart.statusCode,
    });
    return {
      restarted: false,
      reason: `Docker restart failed with status ${restart.statusCode}`,
    };
  }

  logInfo("Container restarted", { container: restartContainerName });
  return { restarted: true };
}

app.get("/api/params", async (_req, res) => {
  try {
    if (verboseLogs) logInfo("Reading mower params", { file: paramsPath });
    const content = await fs.readFile(paramsPath, "utf8");
    const parsed = yaml.load(content);
    const datum = extractGpsDatum(parsed);
    if (!datum) {
      logWarn("Missing datum_lat/datum_long in params file", { file: paramsPath });
      return res.status(422).json({
        error: "datum_lat/datum_long not found in mower_params.yaml",
      });
    }
    if (verboseLogs) logInfo("Loaded mower params datum", datum);
    return res.json(datum);
  } catch (error) {
    if (error.code === "ENOENT") {
      logWarn("Params file not found", { file: paramsPath });
      return res.status(404).json({ error: "mower_params.yaml not found" });
    }
    logError("Failed to read mower params", { file: paramsPath, error: error.message });
    return res.status(500).json({ error: "Failed to read mower params" });
  }
});

app.get("/api/robot_pose", async (_req, res) => {
  try {
    const result = await getRobotPoseCached();
    const body = JSON.stringify({
      container: poseContainerName,
      ...result,
    });
    // Avoid Express res.json → res.send ETag / 304 handling: browsers send
    // If-None-Match on poll; 304 + empty body breaks live pose/status updates.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
    return res.end(body);
  } catch (error) {
    logError("Robot pose endpoint failed", { error: error.message });
    return res.status(500).json({
      ok: false,
      error: error.message || "robot_pose_failed",
    });
  }
});

app.get("/api/wifi-map", async (req, res) => {
  try {
    await ensureWifiSurveyLoaded();
    const knownRevision = Number(req.query.revision);
    res.setHeader("Cache-Control", "no-store");
    if (Number.isFinite(knownRevision) && knownRevision === wifiSurveyRevision) {
      return res.json({ ok: true, notModified: true, ...wifiSurveyMeta() });
    }
    return res.json({ ok: true, ...wifiSurveyMeta(), samples: [...wifiSurvey.values()] });
  } catch (error) {
    logError("Failed to read central WiFi survey", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to read WiFi survey" });
  }
});

app.post("/api/wifi-map/samples", async (req, res) => {
  try {
    await ensureWifiSurveyLoaded();
    const samples = Array.isArray(req.body?.samples)
      ? req.body.samples
      : req.body && typeof req.body === "object"
        ? [req.body]
        : [];
    if (samples.length < 1 || samples.length > wifiMaxPoints) {
      return res.status(400).json({
        ok: false,
        error: `Expected 1-${wifiMaxPoints} WiFi samples`,
      });
    }
    let accepted = 0;
    for (const sample of samples) {
      if (mergeWifiSurveySample(sample)) accepted += 1;
    }
    if (!accepted) {
      return res.status(422).json({ ok: false, error: "No valid WiFi samples" });
    }
    return res.json({ ok: true, accepted, ...wifiSurveyMeta() });
  } catch (error) {
    logError("Failed to record central WiFi samples", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to record WiFi samples" });
  }
});

app.delete("/api/wifi-map", async (_req, res) => {
  try {
    await ensureWifiSurveyLoaded();
    await flushWifiSurvey(true);
    const clearBackupPath = `${wifiMapPath}.bak-clear`;
    try {
      await fs.copyFile(wifiMapPath, clearBackupPath);
      await applyMowerFileOwnership(clearBackupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    logWarn("Clearing central WiFi survey", {
      points: wifiSurvey.size,
      backup: clearBackupPath,
    });
    wifiSurvey.clear();
    wifiSurveyDirty = true;
    wifiSurveyRevision += 1;
    wifiSurveyUpdatedAt = Date.now();
    await flushWifiSurvey(true);
    return res.json({ ok: true, ...wifiSurveyMeta() });
  } catch (error) {
    logError("Failed to clear central WiFi survey", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to clear WiFi survey" });
  }
});

app.get("/api/map", async (_req, res) => {
  try {
    if (verboseLogs) logInfo("Reading active map file", { file: mapPath });
    const content = await fs.readFile(mapPath, "utf8");
    return res.type("application/json").send(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      logWarn("Active map file not found", { file: mapPath });
      return res.status(404).json({ error: "map.json not found" });
    }
    logError("Failed to read active map file", { file: mapPath, error: error.message });
    return res.status(500).json({ error: "Failed to read map.json" });
  }
});

app.get("/api/map/backups", async (_req, res) => {
  try {
    if (verboseLogs) logInfo("Listing map backups", { directory: mapDirectory });
    const entries = await fs.readdir(mapDirectory, { withFileTypes: true });
    const mapFiles = entries
      .filter((entry) => entry.isFile() && isValidMapFileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => {
        if (a === "map.json") return -1;
        if (b === "map.json") return 1;
        return b.localeCompare(a);
      });
    if (verboseLogs) logInfo("Listed map files", { count: mapFiles.length });
    return res.json({ backups: mapFiles });
  } catch (error) {
    logError("Failed to list map backups", { directory: mapDirectory, error: error.message });
    return res.status(500).json({ error: "Failed to list map backups" });
  }
});

app.get("/api/map/backups/:backupName", async (req, res) => {
  try {
    const backupName = req.params.backupName;
    if (!isValidMapFileName(backupName)) {
      return res.status(400).json({ error: "Invalid map file name" });
    }
    const backupPath = path.join(mapDirectory, backupName);
    if (verboseLogs) logInfo("Reading map/backup file", { file: backupPath });
    const content = await fs.readFile(backupPath, "utf8");
    return res.type("application/json").send(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      logWarn("Requested map/backup file not found", { file: req.params.backupName });
      return res.status(404).json({ error: "Backup file not found" });
    }
    logError("Failed to read map/backup file", {
      file: req.params.backupName,
      error: error.message,
    });
    return res.status(500).json({ error: "Failed to read backup file" });
  }
});

app.post("/api/map", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid map payload" });
    }

    const restartRequested = shouldRestartFromQuery(req.query.restart);
    logInfo("Saving map file", { file: mapPath, restartRequested });

    const mapJson = JSON.stringify(req.body, null, 2);
    const backupPath = `${mapPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    try {
      await fs.copyFile(mapPath, backupPath);
      logInfo("Created map backup before save", { backupPath });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      logWarn("No existing map.json found before save; backup skipped", { file: mapPath });
    }

    await fs.writeFile(mapPath, mapJson, "utf8");
    logInfo("Saved map file", { file: mapPath, bytes: Buffer.byteLength(mapJson, "utf8") });

    if (!restartRequested) {
      return res.json({
        ok: true,
        backupPath,
      });
    }

    let restartResult = {
      restarted: false,
      reason: "Docker restart not attempted",
    };
    try {
      restartResult = await restartOpenMowerContainer();
    } catch (error) {
      logError("Restart failed due to docker socket error", {
        container: restartContainerName,
        error: error.message,
      });
      restartResult = {
        restarted: false,
        reason: `Docker socket unavailable (${error.code || "error"})`,
      };
    }

    return res.json({
      ok: true,
      backupPath,
      restartContainer: restartContainerName,
      restartRequested: true,
      restartResult,
    });
  } catch (error) {
    logError("Failed to save map.json", { file: mapPath, error: error.message });
    return res.status(500).json({ error: "Failed to save map.json" });
  }
});

// SPA fallback: serve the built index.html for any non-API GET so the
// single-page app loads on a hard refresh. API 404s fall through untouched.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== "GET") {
    next();
    return;
  }
  res.sendFile(path.join(distDir, "index.html"), (error) => {
    if (error) {
      next();
    }
  });
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception (process crash)", {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", { reason });
});

const server = app.listen(port, () => {
  logInfo("OpenMower Map Editor listening", {
    port,
    mapPath,
    paramsPath,
    restartContainerName,
    poseContainerName,
    poseCacheMs,
    tfEchoTimeoutSec,
    rosTopicSampleTimeoutSec,
    rosTopicFallbackTimeoutSec,
    poseDisabled,
    verboseLogs,
    dockerSocketPath,
    wifiMapPath,
    wifiCellSizeM,
    wifiMaxPoints,
    wifiFlushMs,
    wifiCollectorIntervalMs,
    wifiCollectorTfTimeoutSec,
    wifiCollectorCellRevisitMs,
    wifiCollectorDisabled,
  });
  startAutonomousWifiCollector();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("Shutting down", { signal });
  stopAutonomousWifiCollector();
  server.close();
  try {
    await flushWifiSurvey(true);
  } catch (error) {
    logError("Final WiFi survey flush failed", { error: error.message });
  }
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
