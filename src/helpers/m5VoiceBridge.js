const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const M5DeviceRegistry = require("./m5DeviceRegistry");
const M5OtaService = require("./m5OtaService");
const M5RecordingSessions = require("./m5RecordingSessions");
const M5VoiceBridgeRouter = require("./m5VoiceBridgeRouter");
const M5FollowupKeyDispatcher = require("./m5FollowupKeyDispatcher");
const AudioRoutingManager = require("./audioRoutingManager");
const M5DeviceCommandBroker = require("./m5DeviceCommandBroker");
const PipeWireCaptureController = require("./pipeWireCaptureController");
const PipeWireUnifiedSourceController = require("./pipeWireUnifiedSourceController");
const BluetoothDeviceManager = require("./bluetoothDeviceManager");
const { classifyPcmTransport } = require("./pcmSignalQuality");
const {
  MainRealtimeAsrSession,
  extractText: extractMainAsrText,
  usablePayload: isUsableMainAsrPayload,
} = require("./mainRealtimeAsrSession");
const { ENTER_FOLLOWUP } = require("./m5FollowupKeyDispatcher");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const STOP_WAIT_MS = 210000;
const CYBER_AGENT_TIMEOUT_MS = 180000;
const MAX_TTS_AUDIO_BYTES = 1024 * 1024;
const MAX_CONCURRENT_RECORDINGS = 4;
const RECORDING_FIRST_CHUNK_TIMEOUT_MS = 12000;
const RECORDING_STALL_TIMEOUT_MS = 10000;
const RECORDING_MAX_DURATION_MS = 180000;
const REMOTE_AUDIO_DRAIN_TIMEOUT_MS = 2000;
const REMOTE_AUDIO_DRAIN_QUIET_MS = 400;
const REMOTE_AUDIO_DRAIN_POLL_MS = 25;
const DEFAULT_MINIJOY_BLUETOOTH_MAC = "14:08:08:52:F9:62";
const MAX_DIAGNOSTIC_AGE_MS = 5 * 60 * 1000;
const BLUETOOTH_RECOVERY_COOLDOWN_MS = 60000;
const BLUETOOTH_RECOVERY_TIMEOUT_MS = 180000;
const HOST_AUDIO_FAILURE_REASONS = new Set([
  "audio_capture_exited",
  "audio_input_empty",
  "audio_input_stalled",
  "audio_input_invalid",
  "first_audio_chunk_timeout",
]);

function cleanToken(value) {
  const token = String(value || "").trim();
  if (!token || [
    "change-this-shared-token",
    "paste-generated-token-here",
    "changeme",
    "change-me",
    "your-token",
  ].includes(token)) {
    return "";
  }
  return token;
}

function withoutNestedBridgeState(value) {
  if (Array.isArray(value)) return value.map(withoutNestedBridgeState);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "bridge")
    .map(([key, item]) => [key, withoutNestedBridgeState(item)]));
}

function normalizeBluetoothMac(value) {
  return String(value || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

function diagnosticMatchesTarget(value, targetMac) {
  const target = normalizeBluetoothMac(targetMac);
  if (!target || !value || typeof value !== "object") return false;
  const snapshots = [value.before, value.after, value];
  return snapshots.some((snapshot) => {
    const bluetooth = snapshot?.bridge?.state?.bluetooth || snapshot?.bluetooth;
    return normalizeBluetoothMac(bluetooth?.target_mac) === target;
  });
}

function cleanBridgeIdentity(value, fallback) {
  const identity = String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  return identity.slice(0, 64) || fallback;
}

function cleanBridgeLabel(value, fallback) {
  return String(value || "").trim().slice(0, 64) || fallback;
}

function parseBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer || []) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Hex(buffer) {
  return crc32(buffer).toString(16).padStart(8, "0");
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buffer) {
  if (!buffer || buffer.length === 0) {
    return {};
  }
  return JSON.parse(buffer.toString("utf8"));
}

function normalizeRecordingIntent(value, fallback = "dictation") {
  const normalized = String(value || fallback || "dictation").trim().toLowerCase().replace(/-/g, "_");
  if (["cyber_fortune", "fortune", "fort"].includes(normalized)) {
    return "cyber_fortune";
  }
  if (["cyber_almanac", "almanac", "huangli", "alm"].includes(normalized)) {
    return "cyber_almanac";
  }
  if (normalized === "codex") {
    return "codex";
  }
  return "dictation";
}

function isCyberIntent(intent) {
  return ["cyber_fortune", "cyber_almanac"].includes(String(intent || ""));
}

function cyberServiceForIntent(intent) {
  if (intent === "cyber_almanac") {
    return {
      name: "almanac",
      envName: "VIBE_STICK_ALMANAC_AGENT_CMD",
    };
  }
  return {
    name: "fortune",
    envName: "VIBE_STICK_FORTUNE_AGENT_CMD",
  };
}

function selectCyberAgentCommand(intent, env = process.env) {
  const normalizedIntent = normalizeRecordingIntent(intent);
  if (!isCyberIntent(normalizedIntent)) {
    return {
      intent: normalizedIntent,
      service: "dictation",
      command: "",
      envName: "",
      fallback: false,
    };
  }

  const service = cyberServiceForIntent(normalizedIntent);
  const command = String(env[service.envName] || "").trim();
  if (command) {
    return {
      intent: normalizedIntent,
      service: service.name,
      command,
      envName: service.envName,
      fallback: false,
    };
  }

  const fallbackCommand = String(env.VIBE_STICK_CYBER_AGENT_CMD || "").trim();
  return {
    intent: normalizedIntent,
    service: service.name,
    command: fallbackCommand,
    envName: fallbackCommand ? "VIBE_STICK_CYBER_AGENT_CMD" : service.envName,
    fallback: Boolean(fallbackCommand),
  };
}

function parseCyberAgentOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return { text: "", ttsAudioFile: "", source: "", service: "" };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const data = JSON.parse(lines[index]);
      if (data && typeof data === "object") {
        return {
          text: String(data.text || data.message || ""),
          ttsAudioFile: String(data.tts_audio_file || data.audio_file || ""),
          source: String(data.tts_source || data.agent_source || data.source || ""),
          service: String(data.service || data.agent_service || ""),
        };
      }
    } catch {
      // Keep scanning older lines.
    }
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      return {
        text: String(data.text || data.message || ""),
        ttsAudioFile: String(data.tts_audio_file || data.audio_file || ""),
        source: String(data.tts_source || data.agent_source || data.source || ""),
        service: String(data.service || data.agent_service || ""),
      };
    }
  } catch {
    // Plain text stdout is also accepted.
  }
  return { text, ttsAudioFile: "", source: "", service: "" };
}

function createPcmWavBuffer(chunks, sampleRate = 16000) {
  const pcm = Buffer.concat((chunks || []).map((chunk) => Buffer.from(chunk || [])));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class M5VoiceBridge {
  constructor({
    logger,
    windowManager,
    clipboardManager,
    databaseManager,
    asrConnectionProfiles = null,
    asrSessionFactory = null,
    sendToRenderer,
  }) {
    this.logger = logger;
    this.windowManager = windowManager;
    this.clipboardManager = clipboardManager;
    this.databaseManager = databaseManager;
    this.asrConnectionProfiles = asrConnectionProfiles;
    this.asrSessionFactory = asrSessionFactory;
    this.sendToRenderer = sendToRenderer;
    this.server = null;
    this.recordingSessions = new M5RecordingSessions();
    this.sessions = this.recordingSessions.sessions;
    this.router = new M5VoiceBridgeRouter(this);
    this.followupKeyDispatcher = new M5FollowupKeyDispatcher({
      logger: this.logger,
      runCommand: (...args) => this.runCommand(...args),
    });
    this.deviceRegistry = new M5DeviceRegistry();
    this.devices = this.deviceRegistry.devices;
    this.commandBroker = new M5DeviceCommandBroker();
    this.audioRouting = new AudioRoutingManager({
      databaseManager,
      logger: this.logger,
      wifiDeviceProvider: () => this.listDevices(),
    });
    this.pipeWireCapture = new PipeWireCaptureController({ logger: this.logger });
    this.pipeWireUnifiedSource = new PipeWireUnifiedSourceController({
      logger: this.logger,
    });
    this.bluetoothDevices = new BluetoothDeviceManager({
      runCommand: (...args) => this.runCommand(...args),
      knownMacProvider: () => [
        String(process.env.M5_MINIJOY_BLUETOOTH_MAC || DEFAULT_MINIJOY_BLUETOOTH_MAC),
        ...(this.audioRouting.getState().sources || [])
          .filter((source) => source.bluetooth)
          .map((source) => source.bluetooth_address),
      ],
    });
    this.hostTriggerSessions = new Map();
    this.rendererSessionId = "";
    this.rendererPendingSessionId = "";
    this.rendererQueue = [];
    this.bridgeInstanceId = randomUUID();
    this.recordingFirstChunkTimeoutMs = RECORDING_FIRST_CHUNK_TIMEOUT_MS;
    this.recordingStallTimeoutMs = RECORDING_STALL_TIMEOUT_MS;
    this.recordingMaxDurationMs = RECORDING_MAX_DURATION_MS;
    this.remoteAudioDrainTimeoutMs = REMOTE_AUDIO_DRAIN_TIMEOUT_MS;
    this.remoteAudioDrainQuietMs = REMOTE_AUDIO_DRAIN_QUIET_MS;
    this.remoteAudioDrainPollMs = REMOTE_AUDIO_DRAIN_POLL_MS;
    this.enabled = parseBool(process.env.M5_VOICE_BRIDGE_ENABLED, true);
    this.host = process.env.M5_VOICE_BRIDGE_HOST || DEFAULT_HOST;
    this.port = Number(process.env.M5_VOICE_BRIDGE_PORT || DEFAULT_PORT);
    this.token = cleanToken(process.env.M5_VOICE_BRIDGE_TOKEN || process.env.VIBE_STICK_BRIDGE_TOKEN);
    this.bridgeId = cleanBridgeIdentity(
      process.env.M5_VOICE_BRIDGE_ID || process.env.VIBE_STICK_BRIDGE_ID,
      "capswriter-m5-voice-bridge"
    );
    this.bridgeLabel = cleanBridgeLabel(
      process.env.M5_VOICE_BRIDGE_LABEL || process.env.VIBE_STICK_BRIDGE_LABEL,
      this.bridgeId
    );
    this.otaService = new M5OtaService({
      otaDir: process.env.M5_VOICE_BRIDGE_OTA_DIR || process.env.VIBE_STICK_OTA_DIR,
    });
    this.otaDir = this.otaService.otaDir;
    this.latestTtsAudioFile = "";
    this.ttsPlaybackRequestId = "";
    this.ttsPlaybackQueue = [];
    this.currentTtsPlayback = null;
    this.bluetoothRecoveryInFlight = false;
    this.bluetoothRecoveryPending = false;
    this.bluetoothRecoveryLastAt = 0;
  }

  start() {
    if (!this.enabled || this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.logger?.warn?.("M5 voice bridge request failed", {
          url: req.url,
          method: req.method,
          error: error?.message || String(error),
        });
        this.sendJson(res, error.statusCode || 500, {
          success: false,
          error: error?.message || "M5 voice bridge request failed",
        });
      });
    });
    this.server.on("error", (error) => {
      this.logger?.error?.("M5 voice bridge failed", {
        host: this.host,
        port: this.port,
        error: error?.message || String(error),
      });
    });
    this.server.listen(this.port, this.host, () => {
      this.logger?.info?.("M5 voice bridge listening", {
        host: this.host,
        port: this.port,
        bridgeId: this.bridgeId,
        bridgeLabel: this.bridgeLabel,
        tokenRequired: Boolean(this.token),
      });
    });
  }

  stop() {
    if (!this.server) {
      return;
    }
    this.rendererRecovery = true;
    for (const session of this.sessions.values()) {
      session.mainAsrSession?.cancel?.();
      this.finishSession(session, {
        success: false,
        status: "bridge_stopped",
        error: "M5 voice bridge stopped",
      });
    }
    this.pipeWireCapture.stopAll();
    this.recordingSessions.clear();
    this.hostTriggerSessions.clear();
    this.rendererQueue = [];
    this.rendererSessionId = "";
    this.rendererPendingSessionId = "";
    this.rendererRecovery = false;
    this.server.close();
    this.server = null;
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    req.vibeDevice = this.rememberDevice(req, url.pathname);
    await this.router.handle(req, res, url);
  }

  rememberDevice(req, requestPath) {
    return this.deviceRegistry.remember(req, requestPath);
  }

  pruneDevices(now = Date.now()) {
    this.deviceRegistry.prune(now);
  }

  listDevices() {
    return this.deviceRegistry.listOnline();
  }

  buildDashboardHtml() {
    const devices = this.listDevices();
    const historicalDevices = this.deviceRegistry.listOffline();
    const rows = devices.map((device) => this.deviceRowHtml(device)).join("");
    const bodyRows = rows || '<tr><td colspan="9" class="empty">No M5Stack devices seen yet.</td></tr>';
    const historicalRows = historicalDevices.map((device) => this.deviceRowHtml(device)).join("");
    const updatedAt = escapeHtml(new Date().toLocaleString());
    const routingState = JSON.stringify(this.audioRouting.getState()).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CapsWriter M5 Bridge</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f8; color: #17202a; }
main { max-width: 1180px; margin: 0 auto; padding: 28px 20px; }
h1 { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
.meta { color: #667085; margin-bottom: 24px; }
h2 { margin: 28px 0 12px; font-size: 18px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d5dd; }
th, td { padding: 10px 12px; border-bottom: 1px solid #e4e7ec; text-align: left; font-size: 14px; white-space: nowrap; }
th { color: #344054; background: #f9fafb; font-weight: 600; }
.empty, .muted { color: #667085; }
.empty { text-align: center; padding: 24px; }
.ok { color: #067647; }
.warn { color: #b54708; }
.bad { color: #b42318; }
.bluetooth-list { display: grid; gap: 10px; }
.bluetooth-device { background: #fff; border: 1px solid #d0d5dd; padding: 12px 14px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
.bluetooth-device button { margin-top: 0; }
.bluetooth-status { color: #475467; font-size: 13px; }
.route-grid { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(260px, 2fr); gap: 10px 16px; align-items: center; }
details { margin-top: 14px; border: 1px solid #d0d5dd; background: #fff; padding: 10px 12px; }
summary { cursor: pointer; color: #475467; font-weight: 600; }
.history-list { display: grid; gap: 8px; margin-top: 10px; }
.history-item { color: #667085; font-size: 13px; overflow-wrap: anywhere; }
select { width: 100%; min-height: 38px; border: 1px solid #98a2b3; background: #fff; padding: 6px 9px; }
button { margin-top: 14px; min-height: 38px; border: 0; background: #175cd3; color: #fff; padding: 8px 15px; cursor: pointer; }
#save-status { margin-left: 12px; color: #475467; }
@media (max-width: 720px) { .route-grid { grid-template-columns: 1fr; } main { padding: 20px 12px; overflow-x: auto; } }
</style>
</head>
<body>
<main>
<h1>CapsWriter M5 Bridge</h1>
<div class="meta">${escapeHtml(this.bridgeLabel)} (${escapeHtml(this.bridgeId)}) &middot; Listening on ${escapeHtml(this.host)}:${this.port} &middot; Updated ${updatedAt}</div>
<h2>音频输入路由</h2>
<div id="routes" class="route-grid"></div>
<button id="save-routes" type="button">保存路由</button><span id="save-status"></span>
<details id="inactive-routes-section" hidden><summary>历史/不可用路由</summary><div id="inactive-routes" class="history-list"></div></details>
<h2>实时 MiniJoy 蓝牙设备</h2>
<div id="bluetooth-devices" class="bluetooth-list"><div class="muted">正在读取蓝牙状态...</div></div>
<details id="known-bluetooth-section" hidden><summary>已知但未连接的 MiniJoy</summary><div id="known-bluetooth-devices" class="history-list"></div></details>
<h2>实时在线设备</h2>
<table>
<thead>
<tr><th>Device</th><th>IP</th><th>Board</th><th>Firmware</th><th>Wake</th><th>WiFi</th><th>RSSI</th><th>Last Seen</th><th>Path</th></tr>
</thead>
<tbody>${bodyRows}</tbody>
</table>
${historicalRows ? `<details><summary>最近 24 小时的离线设备</summary><table><thead><tr><th>Device</th><th>IP</th><th>Board</th><th>Firmware</th><th>Wake</th><th>WiFi</th><th>RSSI</th><th>Last Seen</th><th>Path</th></tr></thead><tbody>${historicalRows}</tbody></table></details>` : ""}
</main>
<script>
const state = ${routingState};
const routeRoot = document.getElementById("routes");
const triggerLabel = (id, route) => id === "keyboard"
  ? "键盘按键"
  : id.startsWith("minijoy_bt")
    ? (route.trigger_name || "MiniJoy 蓝牙按键")
    : "WiFi 设备 " + id.slice(5);
for (const [triggerId, route] of Object.entries(state.routes)) {
  const label = document.createElement("label");
  label.textContent = triggerLabel(triggerId, route);
  label.htmlFor = "route-" + triggerId;
  const select = document.createElement("select");
  select.id = "route-" + triggerId;
  select.dataset.triggerId = triggerId;
  for (const source of state.sources.filter((item) => item.online && item.transport_available !== false)) {
    const option = document.createElement("option");
    option.value = source.source_id;
    const audioStatus = source.audio_health?.status || "unknown";
    const statusLabel = !source.online
      ? "（离线）"
      : source.bluetooth && audioStatus === "failed"
        ? "（音频失败）"
        : source.bluetooth && audioStatus === "unknown"
          ? "（音频待验证）"
          : "";
    option.textContent = source.name + statusLabel;
    option.selected = source.source_id === route.source_id;
    select.appendChild(option);
  }
  routeRoot.append(label, select);
}
const inactiveRoutes = Object.values(state.inactive_routes || {});
if (inactiveRoutes.length) {
  const section = document.getElementById("inactive-routes-section");
  const root = document.getElementById("inactive-routes");
  section.hidden = false;
  for (const route of inactiveRoutes) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.textContent = triggerLabel(route.trigger_id, route) + " → " +
      (route.source?.name || route.source_id || "未配置") + "（不可用）";
    root.appendChild(item);
  }
}
document.getElementById("save-routes").addEventListener("click", async () => {
  const status = document.getElementById("save-status");
  const routes = {};
  document.querySelectorAll("select[data-trigger-id]").forEach((select) => {
    routes[select.dataset.triggerId] = { source_id: select.value };
  });
  status.textContent = "保存中...";
  try {
    const response = await fetch("/audio/routing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, routes }),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    status.textContent = "已保存";
  } catch (error) {
    status.textContent = "保存失败：" + error.message;
  }
});
const bluetoothRoot = document.getElementById("bluetooth-devices");
const knownBluetoothSection = document.getElementById("known-bluetooth-section");
const knownBluetoothRoot = document.getElementById("known-bluetooth-devices");
const bluetoothStatusText = (device) => {
  if (device.connected) return "已连接（HID / 音频通道可继续验证）";
  if (device.paired) return "已配对，当前未连接";
  if (device.known) return "已发现，等待配对";
  return "未发现";
};
async function repairBluetooth(mac, confirmCleanup = false, forceCleanup = false) {
  const response = await fetch("/bluetooth/repair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mac,
      confirm_cleanup: confirmCleanup,
      force_cleanup: forceCleanup,
    }),
  });
  const payload = await response.json();
  if (response.status === 409 && payload.requires_cleanup) {
    const confirmed = window.confirm(
      "请先在 MiniJoy 设备端清除旧电脑配置，并让设备进入蓝牙配对模式。\\n\\n" +
      "确认后，电脑只会删除 " + mac + " 的旧配对记录并立即重新配对，不影响其他设备。"
    );
    if (confirmed) return repairBluetooth(mac, true, true);
    return;
  }
  if (!response.ok || !payload.success) {
    throw new Error(payload.detail || payload.error || payload.stage || ("HTTP " + response.status));
  }
  await loadBluetoothDevices();
}
async function loadBluetoothDevices() {
  try {
    const response = await fetch("/bluetooth/devices");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    bluetoothRoot.replaceChildren();
    knownBluetoothRoot.replaceChildren();
    const connected = payload.devices.filter((device) => device.connected);
    const known = payload.devices.filter((device) => !device.connected);
    if (!connected.length) {
      bluetoothRoot.innerHTML = '<div class="muted">当前没有实时连接的 MiniJoy。</div>';
    }
    for (const device of connected) {
      const row = document.createElement("div");
      row.className = "bluetooth-device";
      const text = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = device.label + " · " + device.mac;
      const status = document.createElement("div");
      status.className = "bluetooth-status";
      status.textContent = bluetoothStatusText(device);
      text.append(title, status);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = device.connected ? "重新检查" : "修复连接";
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "正在按 MAC 修复...";
        try {
          await repairBluetooth(device.mac);
        } catch (error) {
          status.textContent = "修复失败：" + error.message;
        } finally {
          button.disabled = false;
        }
      });
      row.append(text, button);
      bluetoothRoot.appendChild(row);
    }
    knownBluetoothSection.hidden = known.length === 0;
    for (const device of known) {
      const item = document.createElement("div");
      item.className = "history-item";
      item.textContent = device.label + " · " + device.mac + " · " + bluetoothStatusText(device);
      knownBluetoothRoot.appendChild(item);
    }
  } catch (error) {
    bluetoothRoot.textContent = "蓝牙状态读取失败：" + error.message;
  }
}
loadBluetoothDevices();
</script>
</body>
</html>`;
  }

  deviceRowHtml(device) {
    const rssi = device.wifi_rssi;
    const rssiClass = rssi === null || rssi === undefined ? "muted" : rssi >= -67 ? "ok" : rssi < -75 ? "bad" : "warn";
    const firmware = [device.firmware_name, device.firmware_version].filter(Boolean).join(" ");
    const buildDate = String(device.build_date || "").trim();
    const firmwareText = buildDate ? `${firmware} (${buildDate})` : firmware;
    const wakeBase = [device.reset_reason, device.wake_cause].filter(Boolean).join("/") || "-";
    const wakeText = [
      device.boot_count ? `${wakeBase} #${device.boot_count}` : wakeBase,
      device.pmic_wake ? `PMIC:${device.pmic_wake}` : "",
      device.pmic_irq ? `IRQ:${device.pmic_irq}` : "",
      device.pmic_timer ? `Timer:${device.pmic_timer}` : "",
      device.pmic_gpio_wake ? `GPIO:${device.pmic_gpio_wake}` : "",
    ].filter(Boolean).join(" ");
    return `<tr>
<td>${escapeHtml(device.device_id)}</td>
<td>${escapeHtml(device.device_ip || device.client_ip)}</td>
<td>${escapeHtml(device.board)}</td>
<td>${escapeHtml(firmwareText)}</td>
<td>${escapeHtml(wakeText)}</td>
<td>${escapeHtml(device.wifi_ssid)}</td>
<td class="${rssiClass}">${escapeHtml(rssi ?? "")}</td>
<td>${escapeHtml(device.last_seen_text)}</td>
<td class="muted">${escapeHtml(device.path)}</td>
</tr>`;
  }

  isLoopbackRequest(req) {
    const remoteAddress = String(req?.socket?.remoteAddress || "").trim().toLowerCase();
    return remoteAddress === "127.0.0.1" ||
      remoteAddress === "::1" ||
      remoteAddress === "::ffff:127.0.0.1";
  }

  isTrustedDashboardOrigin(req) {
    const origin = String(req?.headers?.origin || "").trim();
    if (!origin) return true;
    try {
      const url = new URL(origin);
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const localHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
      const listeningPort = String(this.server?.address?.()?.port || this.port);
      return url.protocol === "http:" && localHost && url.port === listeningPort;
    } catch {
      return false;
    }
  }

  async handleBluetoothDeviceList(res) {
    this.sendJson(res, 200, { success: true, devices: await this.bluetoothDevices.list() });
  }

  repairBluetoothDevice(mac, options = {}) {
    return this.bluetoothDevices.repair(mac, options);
  }

  async handleBluetoothRepair(req, res) {
    if (!this.isLoopbackRequest(req) || !this.isTrustedDashboardOrigin(req)) {
      throw Object.assign(new Error("bluetooth repair is only available on localhost"), { statusCode: 403 });
    }
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    const result = await this.repairBluetoothDevice(body.mac, {
      confirmCleanup: body.confirm_cleanup === true,
      forceCleanup: body.force_cleanup === true,
    });
    this.sendJson(res, result.statusCode || (result.success ? 200 : 502), result);
  }

  requireToken(req, { allowLoopback = false } = {}) {
    if (!this.token) {
      return;
    }
    if (allowLoopback && this.isLoopbackRequest(req)) {
      return;
    }
    const provided = String(req.headers["x-vibe-stick-token"] || "").trim();
    if (provided !== this.token) {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  }

  healthPayload() {
    return {
      ok: true,
      bridge_id: this.bridgeId,
      bridge_label: this.bridgeLabel,
      bridge_name: "capswriter-m5-voice-bridge",
      bridge_version: "1.0.0",
      bridge_instance_id: this.bridgeInstanceId,
      recording_protocol_version: 2,
      max_concurrent_recordings: MAX_CONCURRENT_RECORDINGS,
      recording_first_chunk_timeout_ms: this.recordingFirstChunkTimeoutMs,
      recording_stall_timeout_ms: this.recordingStallTimeoutMs,
      token_required: Boolean(this.token),
    };
  }

  async handleEvent(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    if (["tts_played", "tts_failed", "tts_probe_played", "tts_probe_failed"].includes(String(body.event || ""))) {
      this.completeCurrentTtsPlayback(String(body.event || ""), body);
      this.sendJson(res, 200, this.buildState());
      return;
    }
    if (body.event === "button_followup_enter") {
      await this.handleFollowupKey(body, res, ENTER_FOLLOWUP);
      return;
    }
    if (body.event === "button_followup_escape") {
      this.handleFollowupCancel(body, res);
      return;
    }
    this.sendJson(res, 200, this.buildState());
  }

  buildState() {
    const bluetooth = this.bluetoothDiagnosticState();
    return {
      time: new Date().toISOString(),
      wifi: true,
      ble: bluetooth.ready,
      bluetooth,
      active_provider: "codex",
      provider: {
        id: "codex",
        status: "ONLINE",
        project: "CapsWriter",
        quota_5h_remaining: null,
        quota_7d_remaining: null,
        quota_stale: false,
        quota_updated_at: "",
      },
      codex: {
        status: "ONLINE",
        project: "CapsWriter",
        quota_5h_remaining: null,
        quota_7d_remaining: null,
        quota_stale: false,
        quota_updated_at: "",
      },
      recording: this.currentRecordingState(),
      tts_playback_request_id: this.ttsPlaybackRequestId,
      ...this.healthPayload(),
    };
  }

  bluetoothDiagnosticState() {
    const targetMac = String(process.env.M5_MINIJOY_BLUETOOTH_MAC ||
      DEFAULT_MINIJOY_BLUETOOTH_MAC).trim().toUpperCase();
    const normalizedTargetMac = normalizeBluetoothMac(targetMac);
    const routing = this.getAudioRoutingState();
    const sources = (routing.sources || []).filter((source) => source.bluetooth).map((source) => ({
      source_id: source.source_id,
      name: source.name,
      online: Boolean(source.online),
      enumerated: Boolean(source.enumerated),
      transport_available: Boolean(source.transport_available),
      audio_health: source.audio_health || { status: "unknown" },
      bluetooth_address: source.bluetooth_address || "",
    }));
    const target = sources.find((source) =>
      String(source.bluetooth_address || "").toUpperCase().replace(/[^0-9A-F]/g, "") === normalizedTargetMac);
    const diagnosticFile = process.env.M5_BRIDGE_DIAGNOSTIC_FILE ||
      path.join(os.homedir(), ".cache", "capswriter-agx-client", "m5bridge-doctor.json");
    let diagnostic = null;
    try {
      const stat = fs.statSync(diagnosticFile);
      const rawDiagnostic = JSON.parse(fs.readFileSync(diagnosticFile, "utf8"));
      const recent = Date.now() - stat.mtimeMs <= MAX_DIAGNOSTIC_AGE_MS;
      if (recent && diagnosticMatchesTarget(rawDiagnostic, targetMac)) {
        diagnostic = withoutNestedBridgeState(rawDiagnostic);
      }
    } catch {
      // The diagnostic command is optional; absence is itself represented below.
    }
    const pipewireAvailable = Boolean(target?.transport_available);
    const audioStatus = pipewireAvailable
      ? String(target?.audio_health?.status || "unknown")
      : "unavailable";
    const ready = pipewireAvailable && audioStatus === "healthy";
    const stage = !pipewireAvailable
      ? (diagnostic?.stage || "pipewire_source_missing")
      : audioStatus === "failed"
        ? "audio_capture_failed"
        : audioStatus === "healthy"
          ? "ready"
          : "audio_unverified";
    return {
      target_mac: targetMac,
      stage,
      ready,
      pipewire_available: pipewireAvailable,
      audio_status: audioStatus,
      source: target || null,
      sources,
      last_diagnostic: diagnostic,
    };
  }

  handleOtaManifest(res, url) {
    this.otaService.otaDir = this.otaDir;
    this.sendJson(res, 200, this.otaService.manifest(url.searchParams.get("board")));
  }

  handleOtaBinary(res, url) {
    this.otaService.otaDir = this.otaDir;
    const binary = this.otaService.binary(url.searchParams.get("board"));
    if (!binary) {
      this.sendJson(res, 404, { success: false, error: "OTA image not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": binary.size,
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(binary.binaryPath).pipe(res);
  }

  handleRecordingTts(res) {
    const audioPath = String(this.latestTtsAudioFile || "").trim();
    if (!audioPath) {
      this.sendJson(res, 404, { success: false, error: "TTS audio not found" });
      return;
    }
    let stat;
    try {
      stat = fs.statSync(audioPath);
    } catch {
      this.sendJson(res, 404, { success: false, error: "TTS audio not found" });
      return;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TTS_AUDIO_BYTES) {
      this.sendJson(res, 404, { success: false, error: "TTS audio invalid" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": stat.size,
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(audioPath).pipe(res);
  }

  handleRecordingSource(res, url) {
    if (this.token && String(url.searchParams.get("token") || "") !== this.token) {
      this.sendJson(res, 401, { success: false, error: "unauthorized" });
      return;
    }
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const session = this.sessions.get(sessionId);
    const audioPath = String(session?.audioFile || "").trim();
    if (!session || !audioPath) {
      this.sendJson(res, 404, { success: false, error: "recording source not found" });
      return;
    }
    let stat;
    try {
      stat = fs.statSync(audioPath);
    } catch {
      this.sendJson(res, 404, { success: false, error: "recording source not found" });
      return;
    }
    if (!stat.isFile() || stat.size <= 0) {
      this.sendJson(res, 404, { success: false, error: "recording source invalid" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": stat.size,
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(audioPath).pipe(res);
  }

  currentRecordingState() {
    return this.recordingSessions.currentState();
  }

  hasActiveRecordings() {
    return [...this.sessions.values()].some((session) => !session.done);
  }

  handleFollowupKey(body, res, options) {
    const responseKey = `followup_${options.name}`;
    const sessionId = String(body.session_id || "").trim();
    if (!sessionId) {
      this.sendJson(res, 400, {
        success: false,
        [responseKey]: { status: "missing_session_id" },
      });
      return;
    }

    const queued = this.recordingSessions.queueEnter(sessionId);
    if (queued.status === "session_not_found") {
      this.logger?.warn?.(`M5 follow-up ${options.name} ignored: session not found`, { sessionId });
      this.sendJson(res, 200, {
        success: false,
        [responseKey]: { status: "session_not_found", session_id: sessionId },
      });
      return;
    }

    if (queued.status === "session_completed") {
      this.logger?.info?.(`M5 follow-up ${options.name} rejected: session completed`, {
        sessionId,
        status: queued.session.status,
      });
      this.sendJson(res, 200, {
        success: false,
        [responseKey]: { status: "session_completed", session_id: sessionId },
      });
      return;
    }

    const session = queued.session;
    this.logger?.info?.(`M5 follow-up ${options.name} queued`, {
      sessionId,
      status: session.status,
    });
    this.sendJson(res, 200, {
      success: true,
      [responseKey]: { status: "queued", session_id: sessionId },
    });
  }

  handleFollowupCancel(body, res) {
    const sessionId = String(body.session_id || "").trim();
    if (!sessionId) {
      this.sendJson(res, 400, {
        success: false,
        followup_escape: { status: "missing_session_id" },
      });
      return;
    }

    const cancellation = this.recordingSessions.requestCancel(sessionId);
    if (cancellation.status === "session_not_found") {
      this.logger?.warn?.("M5 follow-up cancel ignored: session not found", { sessionId });
      this.sendJson(res, 200, {
        success: false,
        followup_escape: { status: "session_not_found", session_id: sessionId },
      });
      return;
    }

    if (cancellation.status === "session_completed") {
      this.logger?.info?.("M5 follow-up cancel rejected: session completed", {
        sessionId,
        status: cancellation.session.status,
      });
      this.sendJson(res, 200, {
        success: false,
        followup_escape: { status: "session_completed", session_id: sessionId },
      });
      return;
    }

    const session = cancellation.session;
    this.terminateSession(session, {
      reason: "button_followup_escape",
      success: true,
      status: "cancelled",
      cancelled: true,
      message: "External M5 recording cancelled",
    });
    this.logger?.info?.("M5 follow-up cancelled current recording", { sessionId });
    this.sendJson(res, 200, {
      success: true,
      followup_escape: { status: "cancelled", session_id: sessionId },
    });
  }

  scheduleFollowupKey(session, result = {}, options, reason = "queued") {
    const claim = this.recordingSessions.claimEnterDispatch(session, result);
    if (claim.status !== "claimed") {
      if (claim.status === "paste_not_successful") {
        this.logger?.info?.(`M5 follow-up ${options.name} skipped: paste did not succeed`, {
          sessionId: session?.id,
          status: result.status || session?.status,
          success: result.success !== false,
          reason,
        });
      } else if (claim.status === "no_target_window") {
        this.logger?.warn?.(`M5 follow-up ${options.name} skipped: no target window`, {
          sessionId: session?.id,
          reason,
        });
      }
      return;
    }
    this.followupKeyDispatcher.enqueue({
      sessionId: claim.sessionId,
      targetWindowId: claim.targetWindowId,
      keyName: options.keyName,
      reason,
    }, (dispatchResult) => {
      this.recordingSessions.settleEnterDispatch(session, {
        sent: dispatchResult.success && dispatchResult.status === "sent",
      });
    });
  }

  runCommand(command, args = [], timeoutMs = 2000) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child;

      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          ...payload,
        });
      };

      const timer = setTimeout(() => {
        child?.kill?.("SIGTERM");
        finish({ success: false, error: "timeout" });
      }, timeoutMs);
      timer.unref?.();

      try {
        child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish({ success: false, error: error?.message || String(error) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        finish({ success: false, error: error?.message || String(error) });
      });
      child.on("close", (code) => {
        finish({ success: code === 0, code });
      });
    });
  }

  async handleRecordingStart(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    const sessionId = String(body.session_id || randomUUID().replace(/-/g, "")).trim();
    const intent = normalizeRecordingIntent(body.intent, body.mode);
    const mode = String(body.mode || intent).trim() || intent;
    const triggerId = String(
      body.trigger_id ||
      (req.vibeDevice?.device_id ? `wifi:${req.vibeDevice.device_id}` : "wifi:unknown")
    ).trim();
    const ownerDeviceId = String(req.vibeDevice?.device_id || body.device_id || triggerId).trim();
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.done) {
      if (existing.ownerDeviceId !== ownerDeviceId) {
        this.sendJson(res, 409, { success: false, error: "session_id belongs to another device" });
        return;
      }
      const response = {
        success: true,
        recording: this.recordingStartPayload(existing, true),
      };
      if (!req.vibeDevice) response.state = this.buildState();
      this.sendJson(res, 200, response);
      return;
    }
    const activeCount = [...this.sessions.values()].filter((session) => !session.done).length;
    if (activeCount >= MAX_CONCURRENT_RECORDINGS) {
      this.sendJson(res, 429, { success: false, error: "recording capacity reached" });
      return;
    }
    const preparedTrigger = await this.activatePreparedTrigger(triggerId);
    let route = preparedTrigger.route;
    const requestingSourceId = req.vibeDevice?.device_id
      ? `wifi:${req.vibeDevice.device_id}`
      : triggerId;
    let sourceId = route.source_id || requestingSourceId || triggerId;
    const captureMode = sourceId === requestingSourceId
      ? "device_upload"
      : sourceId.startsWith("wifi:")
        ? "remote_device"
        : "host_capture";
    let bluetoothAudioWake = preparedTrigger.bluetooth_audio_wake;
    if (captureMode === "host_capture") {
      const prepared = bluetoothAudioWake
        ? preparedTrigger
        : await this.prepareAudioRoute(route);
      route = prepared.route;
      bluetoothAudioWake = prepared.bluetooth_audio_wake;
      sourceId = route.source_id || sourceId;
      if (!route.available || !route.source?.node_name) {
        this.audioRouting.clearActiveRoute(triggerId);
        this.restoreUnifiedDefaultSource();
        this.sendJson(res, 422, {
          success: false,
          recording: { status: "start_failed", session_id: sessionId },
          error: "configured PipeWire input is unavailable",
          route,
          bluetooth_audio_wake: bluetoothAudioWake,
        });
        return;
      }
    }
    this.windowManager?.showFloatingBall?.({ rememberActiveWindow: activeCount === 0 });
    const targetWindowId = String(this.windowManager?.previousActiveWindow || "").trim();
    const session = this.recordingSessions.create({
      id: sessionId,
      intent,
      mode,
      targetWindowId,
      ownerDeviceId,
      triggerId,
    });
    session.triggerId = triggerId;
    session.sourceId = sourceId;
    session.captureMode = captureMode;
    session.bluetoothAudioWake = bluetoothAudioWake;
    session.audioRoute = route;
    session.sourceDeviceId = sourceId.startsWith("wifi:") ? sourceId.slice(5) : "";
    session.source = body.source || "m5stickc_plus";
    session.audioSource = body.audio_source || "stickc_plus_pcm";
    session.protocolVersion = Math.max(1, Number(body.protocol_version || 1));
    session.seenChunkIds = new Set();
    this.armSessionWatchdogs(session);
    if (captureMode === "host_capture") {
      this.applyAudioRoute(route);
      const capture = this.pipeWireCapture.start(
        sessionId,
        sourceId,
        (chunk) => this.appendRecordingAudio(session, chunk),
        PipeWireUnifiedSourceController.UNIFIED_SOURCE_NAME,
        this.captureOptionsForSession(session)
      );
      session.capturePid = capture?.pid || null;
    } else {
      this.applyAudioRoute(route, { activateInput: false });
    }
    if (captureMode === "remote_device") {
      this.commandBroker.enqueue(session.sourceDeviceId, {
        type: "recording_start",
        payload: {
          session_id: sessionId,
          trigger_id: triggerId,
          intent,
          mode,
        },
      });
    }
    this.logger?.info?.("M5 recording started", {
      sessionId,
      intent,
      mode,
      triggerId,
      sourceId,
      captureMode,
      targetWindowId: session.targetWindowId || null,
    });
    const response = {
      success: true,
      recording: this.recordingStartPayload(session, false),
    };
    if (!req.vibeDevice) response.state = this.buildState();
    this.sendJson(res, 200, response);
  }

  appendRecordingAudio(session, body) {
    if (!this.recordingSessions.appendAudio(session, body)) {
      return false;
    }
    if (!session.firstAudioAt) {
      session.firstAudioAt = session.lastAudioAt;
      if (session.captureMode === "host_capture") {
        this.audioRouting.recordCaptureSuccess(session.sourceId, { bytes: body.length });
      }
      this.logger?.info?.("M5 first audio chunk accepted", {
        sessionId: session.id,
        delayMs: session.firstAudioAt - session.createdAt,
        bytes: body.length,
      });
    }
    const chunk = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    const dispatchedNow = !session.rendererDispatched &&
      this.dispatchRendererSessionIfIdle(session);
    if (dispatchedNow) {
      return true;
    }
    if (this.rendererSessionId === session.id) {
      this.sendToRenderer("external-recording-chunk", {
        session_id: session.id,
        chunk,
        byte_length: body.length,
      });
    }
    return true;
  }

  applyAudioRoute(route, { activateInput = true } = {}) {
    if (!route) return { input_applied: false, output_applied: false };
    const sinkNodeName = route.output_available ? route.sink?.node_name : "";
    let result = {};
    let inputApplied = false;
    let outputApplied = false;
    if (
      activateInput &&
      route.available &&
      route.source?.kind === "pipewire" &&
      route.source?.node_name
    ) {
      result = this.pipeWireUnifiedSource.activate(
        route.source.node_name,
        sinkNodeName
      );
      inputApplied = true;
      outputApplied = Boolean(sinkNodeName);
    } else if (sinkNodeName) {
      result = this.pipeWireUnifiedSource.setDefaultSink(sinkNodeName);
      outputApplied = true;
    }
    return {
      route,
      input_applied: inputApplied,
      output_applied: outputApplied,
      ...result,
    };
  }

  async prepareAudioRoute(route) {
    const sourceId = String(route?.source_id || "");
    const match = sourceId.match(/bluez_input\.([0-9a-f_:-]{17})/i);
    if (!match) {
      return { route, bluetooth_audio_wake: null };
    }
    const mac = match[1].replace(/_/g, ":").toUpperCase();
    const wake = await this.bluetoothDevices.activateAudioProfile(mac, 3);
    if (!wake.success) {
      this.logger?.warn?.("MiniJoy mSBC wake failed before recording", {
        triggerId: route.trigger_id,
        sourceId,
        mac,
        detail: wake.detail || "",
      });
    }
    return {
      route: this.audioRouting.activateTrigger(route.trigger_id),
      bluetooth_audio_wake: wake,
    };
  }

  async activatePreparedTrigger(triggerId) {
    const cleanTriggerId = String(triggerId || "").trim();
    const configuredSourceId = String(
      this.audioRouting.loadRoutes().routes?.[cleanTriggerId]?.source_id || ""
    );
    const wantsBluetoothInput =
      configuredSourceId.startsWith("pipewire:bluez_input.") ||
      (!configuredSourceId && cleanTriggerId.startsWith("minijoy_bt"));
    if (!wantsBluetoothInput) {
      return {
        route: this.audioRouting.activateTrigger(cleanTriggerId),
        bluetooth_audio_wake: null,
      };
    }
    const compactMac = (
      configuredSourceId.match(/bluez_input\.([0-9a-f_:-]{12,17})/i)?.[1] ||
      cleanTriggerId.split(":").slice(1).join("")
    ).replace(/[^0-9a-f]/gi, "").toUpperCase();
    const defaultMac = normalizeBluetoothMac(
      process.env.M5_MINIJOY_BLUETOOTH_MAC || DEFAULT_MINIJOY_BLUETOOTH_MAC
    );
    const normalizedMac = compactMac.length === 12 ? compactMac : defaultMac;
    const mac = normalizedMac.match(/.{2}/g)?.join(":") || "";
    let wake = mac
      ? await this.bluetoothDevices.activateAudioProfile(mac, 3)
      : { success: false, detail: "MiniJoy Bluetooth MAC is unavailable" };
    if (mac && !wake.success) {
      wake = await this.bluetoothDevices.resetAudioProfile(mac, 8);
    }
    const route = this.audioRouting.activateTrigger(cleanTriggerId, {
      fallbackToAvailable: false,
    });
    if (!wake.success || !route.available || !route.source?.node_name) {
      this.logger?.warn?.("MiniJoy PipeWire source unavailable after HFP wake", {
        triggerId: cleanTriggerId,
        mac,
        wakeSuccess: wake.success,
        wakeDetail: wake.detail || "",
        sourceId: route.source_id || "",
      });
    }
    return { route, bluetooth_audio_wake: wake };
  }

  captureOptionsForSession(session) {
    const base = {
      onUnexpectedExit: (details) => this.abortSession(session, "audio_capture_exited", details),
    };
    const match = String(session?.sourceId || "")
      .match(/bluez_input\.([0-9a-f_:-]{12,17})/i);
    if (!match) return base;
    const compactMac = match[1].replace(/[^0-9a-f]/gi, "").toUpperCase();
    const mac = compactMac.length === 12 ? compactMac.match(/.{2}/g).join(":") : "";
    return {
      ...base,
      firstChunkRetryMs: 3000,
      maxStartAttempts: 2,
      initialAudioBytes: 12288,
      maxInitialAudioBytes: 32000,
      deferredInvalidAudioReasons: ["all_zero", "frozen", "sparse_frozen"],
      validateInitialAudio: classifyPcmTransport,
      onInvalidAudio: (details) => this.abortSession(session, "audio_input_invalid", details),
      beforeRetry: async () => {
        const reset = await this.bluetoothDevices.resetAudioProfile(mac, 8);
        const route = this.audioRouting.activateTrigger(session.triggerId, {
          fallbackToAvailable: false,
        });
        if (reset.success && route.available && route.source?.node_name) {
          session.audioRoute = route;
          this.applyAudioRoute(route);
        }
        this.logger?.[reset.success ? "info" : "warn"]?.(
          "MiniJoy HFP profile reset before capture retry",
          {
            sessionId: session.id,
            mac,
            success: reset.success,
            recovery: reset.recovery || "",
            detail: reset.detail || "",
          }
        );
      },
    };
  }

  prepareMainAsrSession(session) {
    if (!session || session.done || session.mainAsrSession || session.mainAsrDisabled) {
      return session?.mainAsrSession || null;
    }
    if (!this.asrSessionFactory && !this.asrConnectionProfiles) {
      session.mainAsrDisabled = true;
      return null;
    }
    const translateMode = String(
      this.databaseManager?.getSetting?.("voice_translate_mode", "transcribe") || "transcribe"
    );
    const translateTarget = String(
      this.databaseManager?.getSetting?.("voice_translate_target", "zh") || "zh"
    );
    const options = {
      connectionProvider: async () => this.asrConnectionProfiles?.getActiveConnection?.(),
      logger: this.logger,
      sampleRate: session.sampleRate || 16000,
      optimizeMode: translateMode === "translate" ? "translate" : "none",
      translateTarget,
      onEvent: (payload) => {
        const type = String(payload?.type || "").toLowerCase();
        if (type === "ready" || type === "final") {
          this.logger?.info?.(`Main-process realtime ASR ${type}`, {
            sessionId: session.id,
            requestId: payload?.request_id || null,
            textLength: type === "final" ? extractMainAsrText(payload).length : 0,
          });
        }
        if (type === "partial" || type === "ready") {
          this.sendToRenderer("external-transcription-progress", {
            session_id: session.id,
            event: payload,
          });
        }
      },
    };
    session.mainAsrSession = this.asrSessionFactory
      ? this.asrSessionFactory(options, session)
      : new MainRealtimeAsrSession(options);
    session.mainAsrStartPromise = Promise.resolve(session.mainAsrSession.start())
      .catch((error) => {
        session.mainAsrError = error;
        this.logger?.warn?.("Main-process realtime ASR failed to start", {
          sessionId: session.id,
          error: error?.message || String(error),
        });
        return null;
      });
    return session.mainAsrSession;
  }

  finalizeMainAsrSession(session) {
    if (!session || session.done || session.mainAsrFinalizePromise) {
      return session?.mainAsrFinalizePromise || null;
    }
    const asrSession = this.prepareMainAsrSession(session);
    if (!asrSession) return null;
    session.mainAsrFinalizePromise = (async () => {
      await session.mainAsrStartPromise;
      if (session.mainAsrError) throw session.mainAsrError;
      const result = await asrSession.finish();
      if (!isUsableMainAsrPayload(result)) {
        throw new Error("Realtime ASR returned no usable result");
      }
      const text = extractMainAsrText(result);
      this.sendToRenderer("external-recording-result", {
        session_id: session.id,
        result: {
          ...result,
          success: result?.success !== false,
          text,
          asr_text: result?.asr_text || result?.text || text,
          file_size: session.bytes,
        },
      });
      return result;
    })().catch((error) => {
      if (session.done || session.terminationStarted) return null;
      const message = error?.message || String(error);
      this.logger?.warn?.("Main-process realtime ASR finalization failed", {
        sessionId: session.id,
        error: message,
      });
      this.sendToRenderer("external-recording-result", {
        session_id: session.id,
        error: message,
        result: {
          success: false,
          error: message,
          text: "",
          asr_text: "",
          file_size: session.bytes,
        },
      });
      return null;
    });
    return session.mainAsrFinalizePromise;
  }

  cancelConflictingLocalRecordings(triggerId, reason = "audio_route_handoff") {
    const cancelled = [];
    for (const session of [...this.sessions.values()]) {
      if (
        session.done ||
        session.triggerId === triggerId ||
        session.captureMode !== "host_capture"
      ) {
        continue;
      }
      if (this.terminateSession(session, {
        success: true,
        status: "cancelled",
        cancelled: true,
        reason,
        message: "Recording cancelled because another local audio route took over",
      })) {
        cancelled.push(session.id);
      }
    }
    return cancelled;
  }

  restoreUnifiedDefaultSource() {
    const sources = this.audioRouting.listSources();
    const sinks = this.audioRouting.listSinks();
    const saved = this.audioRouting.routesForSources(sources);
    const activeRoute = this.audioRouting.latestActiveRoute();
    const triggerId = activeRoute?.trigger_id || "keyboard";
    const route = this.audioRouting.resolveRoute(
      triggerId,
      sources,
      activeRoute ? saved : { version: 3, routes: {} },
      {
        fallbackToAvailable: true,
        sinks,
      }
    );
    if (route.available || route.output_available) {
      return this.applyAudioRoute(route, {
        activateInput: route.source?.kind === "pipewire",
      });
    }
    this.pipeWireUnifiedSource.deactivate();
    return null;
  }

  async handleRecordingAudio(req, res, url) {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const chunkId = String(url.searchParams.get("chunk_id") || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session || session.done) {
      this.sendJson(res, 404, { success: false, error: "recording session not found" });
      return;
    }
    const requestDeviceId = String(req.vibeDevice?.device_id || "").trim();
    if (requestDeviceId && session.ownerDeviceId && requestDeviceId !== session.ownerDeviceId) {
      this.logger?.warn?.("M5 audio chunk rejected", {
        sessionId,
        statusCode: 403,
        error: "recording session belongs to another device",
        requestDeviceId,
        ownerDeviceId: session.ownerDeviceId,
      });
      this.sendJson(res, 403, { success: false, error: "recording session belongs to another device" });
      return;
    }
    session.lastUploadAttemptAt = Date.now();
    const body = await readRequestBody(req, MAX_AUDIO_CHUNK_BYTES);
    const strictProtocol = session.protocolVersion >= 2;
    const numericChunkId = chunkId === "" ? null : Number(chunkId);
    const duplicate = strictProtocol
      ? numericChunkId !== null && numericChunkId < session.expectedChunkId
      : Boolean(chunkId && session.seenChunkIds.has(chunkId));
    if (numericChunkId !== null && (!Number.isInteger(numericChunkId) || numericChunkId < 0)) {
      this.logger?.warn?.("M5 audio chunk rejected", {
        sessionId, statusCode: 400, error: "invalid chunk_id", chunkId,
      });
      this.sendJson(res, 400, { success: false, error: "invalid chunk_id" });
      return;
    }
    if (strictProtocol && numericChunkId === null) {
      this.logger?.warn?.("M5 audio chunk rejected", {
        sessionId, statusCode: 400, error: "chunk_id is required for protocol v2",
      });
      this.sendJson(res, 400, { success: false, error: "chunk_id is required for protocol v2" });
      return;
    }
    if (strictProtocol && numericChunkId > session.expectedChunkId) {
      this.logger?.warn?.("M5 audio chunk rejected", {
        sessionId,
        statusCode: 409,
        error: "audio chunk out of order",
        chunkId: numericChunkId,
        expectedChunkId: session.expectedChunkId,
      });
      this.sendJson(res, 409, {
        success: false,
        error: "audio chunk out of order",
        recording: { session_id: sessionId, expected_chunk_id: session.expectedChunkId },
      });
      return;
    }
    if (strictProtocol) {
      const expectedCrc = String(
        req.headers["x-vibe-stick-chunk-crc32"] || url.searchParams.get("chunk_crc32") || ""
      ).trim().toLowerCase().replace(/^0x/, "");
      const actualCrc = crc32Hex(body);
      if (!expectedCrc || expectedCrc !== actualCrc) {
        this.logger?.warn?.("M5 audio chunk rejected", {
          sessionId,
          statusCode: 422,
          error: expectedCrc ? "audio chunk checksum mismatch" : "chunk CRC32 is required for protocol v2",
          chunkId: numericChunkId,
          expectedChunkId: session.expectedChunkId,
          expectedCrc: expectedCrc || null,
          actualCrc,
        });
        this.sendJson(res, 422, {
          success: false,
          error: expectedCrc ? "audio chunk checksum mismatch" : "chunk CRC32 is required for protocol v2",
          recording: { session_id: sessionId, expected_chunk_id: session.expectedChunkId, actual_crc32: actualCrc },
        });
        return;
      }
    }
    if (!duplicate) {
      this.appendRecordingAudio(session, body);
      if (strictProtocol) session.expectedChunkId += 1;
      else if (chunkId) session.seenChunkIds.add(chunkId);
    }
    const recording = {
      status: "recording",
      session_id: sessionId,
      bytes: session.bytes,
      chunks: session.chunks,
      chunk_id: chunkId,
      duplicate,
    };
    if (strictProtocol) recording.expected_chunk_id = session.expectedChunkId;
    this.sendJson(res, 200, {
      success: true,
      recording,
    });
  }

  async handleRecordingStop(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    const sessionId = String(body.session_id || this.latestSessionId() || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendJson(res, 404, {
        success: false,
        recording: { status: "stop_failed", session_id: sessionId },
        error: "recording session not found",
      });
      return;
    }
    const requestDeviceId = String(req.vibeDevice?.device_id || body.device_id || "").trim();
    if (requestDeviceId && session.ownerDeviceId && requestDeviceId !== session.ownerDeviceId) {
      this.sendJson(res, 403, { success: false, error: "recording session belongs to another device" });
      return;
    }
    if (session.done) {
      if (session.status === "cancelled") {
        const response = {
          success: true,
          recording: {
            status: "cancelled",
            session_id: sessionId,
            transcript: "",
            intent: session.intent,
            message: session.result?.message || "External M5 recording cancelled",
          },
        };
        if (!req.vibeDevice) response.state = this.buildState();
        this.sendJson(res, 200, response);
        return;
      }
      this.sendJson(res, 404, {
        success: false,
        recording: { status: "stop_failed", session_id: sessionId },
        error: "recording session already completed",
      });
      return;
    }
    if (session.protocolVersion >= 2) {
      if (body.upload_failed === true) {
        this.abortSession(session, "device_audio_upload_failed");
        this.sendJson(res, 422, {
          success: false,
          recording: { status: "recording_failed", session_id: sessionId },
          error: "device reported an audio upload failure",
        });
        return;
      }
      const totalChunks = Number(body.total_chunks);
      const totalBytes = Number(body.total_bytes);
      if (!Number.isInteger(totalChunks) || !Number.isInteger(totalBytes) ||
          totalChunks !== session.chunks || totalBytes !== session.bytes) {
        this.abortSession(session, "audio_integrity_mismatch", {
          expectedChunks: session.chunks,
          expectedBytes: session.bytes,
          reportedChunks: body.total_chunks,
          reportedBytes: body.total_bytes,
        });
        this.sendJson(res, 422, {
          success: false,
          recording: { status: "recording_failed", session_id: sessionId },
          error: "audio totals do not match",
        });
        return;
      }
    }
    if (session.bytes === 0) {
      this.abortSession(session, "audio_input_empty");
      this.sendJson(res, 422, {
        success: false,
        recording: { status: "recording_failed", session_id: sessionId },
        error: "recording contains no audio",
      });
      return;
    }
    session.status = "stopping";
    if (session.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
      session.watchdogTimer = null;
    }
    this.pipeWireCapture.stop(sessionId);
    if (session.captureMode === "remote_device" && session.sourceDeviceId) {
      const command = this.commandBroker.enqueue(session.sourceDeviceId, {
        type: "recording_stop",
        payload: { session_id: sessionId },
      });
      const acknowledgement = await this.commandBroker.waitForAcknowledgement(
        session.sourceDeviceId,
        command.command_id
      );
      if (!acknowledgement || acknowledgement.status !== "completed") {
        this.logger?.warn?.("Remote audio stop was not acknowledged", {
          sessionId,
          deviceId: session.sourceDeviceId,
          acknowledgement,
        });
      }
    }
    session.status = "queued";
    session.intent = normalizeRecordingIntent(body.intent, session.intent);
    session.mode = String(body.mode || session.mode || session.intent).trim() || session.intent;
    const paste = body.paste !== false && !isCyberIntent(session.intent);
    if (session.targetWindowId) {
      this.clipboardManager?.setTargetWindow?.(session.targetWindowId);
      this.logger?.info?.("M5 recording target window set", {
        sessionId,
        targetWindowId: session.targetWindowId,
      });
    } else {
      this.logger?.warn?.("M5 recording has no target window", { sessionId });
    }
    session.paste = paste;
    session.rendererStopped = true;
    if (this.rendererSessionId === session.id) {
      this.dispatchRendererStop(session);
    } else if (!this.rendererQueue.includes(session.id)) {
      this.rendererQueue.push(session.id);
    }
    this.audioRouting.clearActiveRoute(session.triggerId);
    this.restoreUnifiedDefaultSource();

    const result = await this.waitForSessionResult(session);
    const response = {
      success: result.success !== false,
      recording: {
        status: result.status || (result.success === false ? "transcription_failed" : "pasted"),
        session_id: sessionId,
        transcript: result.text || "",
        intent: session.intent,
        agent_text: result.agent_text || "",
        tts_audio_file: result.tts_audio_file || "",
        agent_source: result.agent_source || "",
        message: result.error || result.message || "",
      },
    };
    if (!req.vibeDevice) response.state = this.buildState();
    this.sendJson(res, 200, response);
  }

  getAudioRoutingState() {
    return this.audioRouting.getState();
  }

  usesSystemDefaultAudioCapture(triggerId) {
    return this.audioRouting.usesSystemDefaultCapture(triggerId);
  }

  resolveOutputSinkNodeName(triggerId = "keyboard") {
    const state = this.audioRouting.getState();
    const route = state.routes?.[triggerId] || state.routes?.keyboard;
    return String(route?.sink?.node_name || "").trim();
  }

  async handleAudioRoutingUpdate(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    this.audioRouting.saveRoutes(body);
    const applied = this.restoreUnifiedDefaultSource();
    this.sendJson(res, 200, {
      success: true,
      applied,
      routing: this.audioRouting.getState(),
    });
  }

  async handleDeviceCommandPoll(req, res, url) {
    const deviceId = String(
      req.vibeDevice?.device_id || url.searchParams.get("device_id") || ""
    ).trim();
    if (!deviceId) {
      this.sendJson(res, 400, { success: false, error: "device_id is required" });
      return;
    }
    const cursor = Number(url.searchParams.get("cursor") || 0);
    const timeoutMs = Number(url.searchParams.get("timeout_ms") || 25000);
    const command = await this.commandBroker.poll(deviceId, cursor, timeoutMs);
    this.sendJson(res, 200, {
      success: true,
      cursor: command?.cursor || this.commandBroker.latestCursor(deviceId),
      command,
    });
  }

  async handleDeviceCommandAck(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    const deviceId = String(req.vibeDevice?.device_id || body.device_id || "").trim();
    if (!deviceId) {
      this.sendJson(res, 400, { success: false, error: "device_id is required" });
      return;
    }
    const acknowledgement = this.commandBroker.acknowledge(deviceId, body);
    this.sendJson(res, 200, { success: true, acknowledgement });
  }

  async handleHostTriggerDown(triggerId, targetWindowId = "", options = {}) {
    if (this.hostTriggerSessions.has(triggerId)) {
      const sessionId = this.hostTriggerSessions.get(triggerId);
      return { handled: true, duplicate: true, session_id: sessionId };
    }
    const activeCount = [...this.sessions.values()].filter((session) => !session.done).length;
    if (activeCount >= MAX_CONCURRENT_RECORDINGS) {
      return { handled: false, busy: true };
    }
    const preparedTrigger = await this.activatePreparedTrigger(triggerId);
    let route = preparedTrigger.route;
    if (!route.source_id.startsWith("wifi:")) {
      const prepared = preparedTrigger.bluetooth_audio_wake
        ? preparedTrigger
        : await this.prepareAudioRoute(route);
      route = prepared.route;
      if (route.available && route.source.node_name) {
        this.applyAudioRoute(route);
      }
      if (!route.available || !route.source.node_name) {
        return { handled: false, route };
      }

      const sessionId = randomUUID().replace(/-/g, "");
      const intent = normalizeRecordingIntent(options.intent, "dictation");
      const session = this.createHostRecordingSession({
        sessionId,
        triggerId,
        route,
        targetWindowId,
        captureMode: "host_capture",
        intent,
        mode: String(options.mode || intent),
      });
      session.bluetoothAudioWake = prepared.bluetooth_audio_wake;
      const capture = this.pipeWireCapture.start(
        sessionId,
        route.source_id,
        (chunk) => this.appendRecordingAudio(session, chunk),
        PipeWireUnifiedSourceController.UNIFIED_SOURCE_NAME,
        this.captureOptionsForSession(session)
      );
      session.capturePid = capture?.pid || null;
      return { handled: true, route, session_id: sessionId };
    }

    this.applyAudioRoute(route, { activateInput: false });
    const sessionId = randomUUID().replace(/-/g, "");
    const sourceDeviceId = route.source_id.slice(5);
    const intent = normalizeRecordingIntent(options.intent, "dictation");
    this.createHostRecordingSession({
      sessionId,
      triggerId,
      route,
      targetWindowId,
      captureMode: "remote_device",
      sourceDeviceId,
      intent,
      mode: String(options.mode || intent),
    });
    this.commandBroker.enqueue(sourceDeviceId, {
      type: "recording_start",
      payload: {
        session_id: sessionId,
        trigger_id: triggerId,
        intent,
        mode: String(options.mode || intent),
      },
    });
    return { handled: true, route, session_id: sessionId };
  }

  createHostRecordingSession({
    sessionId,
    triggerId,
    route,
    targetWindowId,
    captureMode,
    sourceDeviceId = "",
    intent = "dictation",
    mode = intent,
  }) {
    const session = this.recordingSessions.create({
      id: sessionId,
      intent,
      mode,
      targetWindowId,
      ownerDeviceId: triggerId,
      triggerId,
    });
    Object.assign(session, {
      triggerId,
      sourceId: route.source_id,
      sourceDeviceId,
      captureMode,
      audioRoute: route,
      seenChunkIds: new Set(),
    });
    this.hostTriggerSessions.set(triggerId, sessionId);
    session.source = "audio_router";
    session.audioSource = route.source_id;
    this.armRendererSessionIfIdle(session);
    this.armSessionWatchdogs(session);
    return session;
  }

  async handleHostTriggerUp(triggerId) {
    const sessionId = this.hostTriggerSessions.get(triggerId);
    if (!sessionId) {
      this.audioRouting.clearActiveRoute(triggerId);
      this.restoreUnifiedDefaultSource();
      return { handled: false };
    }
    this.hostTriggerSessions.delete(triggerId);
    const session = this.sessions.get(sessionId);
    if (!session || session.done) {
      return { handled: true, session_id: sessionId };
    }
    session.status = "stopping";
    if (session.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
      session.watchdogTimer = null;
    }
    let acknowledgement = null;
    if (session.captureMode === "host_capture") {
      this.pipeWireCapture.stop(sessionId);
    } else {
      const command = this.commandBroker.enqueue(session.sourceDeviceId, {
        type: "recording_stop",
        payload: { session_id: sessionId },
      });
      const acknowledgementStartedAt = Date.now();
      const acknowledgementPromise = this.commandBroker.waitForAcknowledgement(
        session.sourceDeviceId,
        command.command_id
      );
      session.remoteStopAcknowledgementPromise = acknowledgementPromise;
      void acknowledgementPromise.then((result) => {
        session.remoteStopAcknowledgement = result;
        if (!result || result.status !== "completed") {
          this.logger?.warn?.("Host-triggered remote audio stop was not acknowledged", {
            sessionId,
            deviceId: session.sourceDeviceId,
            acknowledgement: result,
          });
          return;
        }
        this.logger?.info?.("Host-triggered remote audio stop acknowledged in background", {
          sessionId,
          deviceId: session.sourceDeviceId,
          elapsedMs: Date.now() - acknowledgementStartedAt,
        });
      }).catch((error) => {
        this.logger?.warn?.("Host-triggered remote audio stop acknowledgement failed", {
          sessionId,
          deviceId: session.sourceDeviceId,
          error: error?.message || String(error),
        });
      });
      acknowledgement = await this.waitForRemoteAudioDrain(session, acknowledgementPromise);
    }
    if (session.bytes === 0) {
      if (this.isRendererVisibleSession(session)) {
        session.rendererErrorDispatched = true;
        this.sendToRenderer("external-recording-error", {
          session_id: session.id,
          trigger_id: triggerId,
          reason: "audio_input_empty",
          error: "未收到麦克风音频",
        });
      }
      this.abortSession(session, "audio_input_empty");
      return { handled: true, session_id: sessionId, acknowledgement, error: "recording contains no audio" };
    }
    session.status = "queued";
    session.paste = true;
    session.rendererStopped = true;
    if (this.rendererSessionId === session.id) {
      this.dispatchRendererStop(session);
    } else if (!this.rendererQueue.includes(session.id)) {
      this.rendererQueue.push(session.id);
    }
    this.audioRouting.clearActiveRoute(triggerId);
    this.restoreUnifiedDefaultSource();
    return { handled: true, session_id: sessionId, acknowledgement };
  }

  async waitForRemoteAudioDrain(session, acknowledgementPromise) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(0, Number(this.remoteAudioDrainTimeoutMs || 0));
    const quietMs = Math.max(0, Number(this.remoteAudioDrainQuietMs || 0));
    const pollMs = Math.max(1, Number(this.remoteAudioDrainPollMs || 1));
    let observedBytes = session?.bytes || 0;
    let lastAudioChangeAt = startedAt;
    let acknowledgement = null;
    let acknowledgementSettled = false;
    const settledAcknowledgement = Promise.resolve(acknowledgementPromise).then(
      (result) => ({ settled: true, result }),
      () => ({ settled: true, result: null })
    );

    while (Date.now() - startedAt < timeoutMs) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const delay = new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ settled: false }),
          Math.min(pollMs, remainingMs)
        );
        timer.unref?.();
      });
      const outcome = acknowledgementSettled
        ? await delay
        : await Promise.race([settledAcknowledgement, delay]);
      if (outcome.settled) {
        acknowledgementSettled = true;
        acknowledgement = outcome.result;
        if (acknowledgement?.status === "completed") {
          return acknowledgement;
        }
      }
      if ((session?.bytes || 0) !== observedBytes) {
        observedBytes = session.bytes;
        lastAudioChangeAt = Date.now();
      }
      if (observedBytes > 0 && Date.now() - lastAudioChangeAt >= quietMs) {
        return acknowledgement;
      }
    }
    return acknowledgement;
  }

  latestSessionId() {
    return this.recordingSessions.latestId();
  }

  waitForSessionResult(session) {
    return this.recordingSessions.waitForResult(session, STOP_WAIT_MS, () => {
      this.finishSession(session, {
        success: false,
        status: "transcription_failed",
        error: "Timed out waiting for CapsWriter renderer",
      });
    });
  }

  async handleRendererResult(payload = {}) {
    const sessionId = String(payload.session_id || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: "recording session not found" };
    }
    if (session.done) {
      return { success: true, status: session.status };
    }
    if (isCyberIntent(session.intent)) {
      this.startCyberAgentForSession(session, payload);
      this.finishSession(session, {
        success: true,
        status: "cyber_processing",
        intent: session.intent,
        text: String(payload.text || payload.asr_text || "").trim(),
        message: "Cyber agent streaming",
      });
      return { success: true };
    }
    const rendererFailed = payload.success === false ||
      String(payload.status || "") === "transcription_failed";
    const bluetoothHostCapture = session.captureMode === "host_capture" &&
      String(session.sourceId || "").startsWith("pipewire:bluez_input.");
    if (rendererFailed && bluetoothHostCapture && session.pcmFile) {
      try {
        const quality = classifyPcmTransport(fs.readFileSync(session.pcmFile));
        if (!quality.valid) {
          const details = {
            validationReason: quality.reason,
            metrics: quality.metrics,
          };
          this.audioRouting.recordCaptureFailure(
            session.sourceId,
            "audio_input_invalid",
            details
          );
          this.logger?.warn?.("MiniJoy ASR failed with invalid Bluetooth PCM", {
            sessionId: session.id,
            sourceId: session.sourceId,
            ...details,
          });
          this.queueBluetoothAudioRecovery(session, "audio_input_invalid");
        }
      } catch (error) {
        this.logger?.warn?.("Unable to inspect failed MiniJoy PCM", {
          sessionId: session.id,
          error: error?.message || String(error),
        });
      }
    }
    this.finishSession(session, payload);
    return { success: true };
  }

  recordingStartPayload(session, duplicate = false) {
    return {
      status: "recording",
      session_id: session.id,
      intent: session.intent,
      capture_mode: session.captureMode,
      source_id: session.sourceId,
      duplicate,
      expected_chunk_id: session.expectedChunkId,
      bridge_instance_id: this.bridgeInstanceId,
      audio_format: { codec: "pcm_s16le", sample_rate: 16000, channels: 1 },
    };
  }

  rendererStartPayload(session) {
    return {
      session_id: session.id,
      source: session.source || "audio_router",
      audio_source: session.audioSource || session.sourceId,
      sample_rate: session.sampleRate || 16000,
      bits_per_sample: 16,
      channels: 1,
      mode: session.intent,
      trigger_mode: session.mode,
      intent: session.intent,
    };
  }

  isRendererVisibleSession(session) {
    return Boolean(session?.id && (
      this.rendererSessionId === session.id ||
      this.rendererPendingSessionId === session.id
    ));
  }

  armRendererSessionIfIdle(session) {
    if (!session || session.done || this.rendererSessionId || this.rendererPendingSessionId) {
      return false;
    }
    this.rendererPendingSessionId = session.id;
    session.rendererArmed = true;
    this.sendToRenderer("external-recording-armed", {
      session_id: session.id,
      trigger_id: session.triggerId,
      source_id: session.sourceId,
      mode: session.mode,
      intent: session.intent,
    });
    return true;
  }

  dispatchRendererSessionIfIdle(session) {
    if (this.rendererSessionId || !session || session.done || session.rendererDispatched || session.bytes <= 0) {
      return false;
    }
    if (this.rendererPendingSessionId && this.rendererPendingSessionId !== session.id) {
      return false;
    }
    if (this.rendererPendingSessionId === session.id) {
      this.rendererPendingSessionId = "";
    }
    this.rendererSessionId = session.id;
    session.rendererDispatched = true;
    this.sendToRenderer("external-recording-start", this.rendererStartPayload(session));
    if (session.bytes > 0 && session.pcmFile) {
      const pcm = fs.readFileSync(session.pcmFile);
      for (let offset = 0; offset < pcm.length; offset += MAX_AUDIO_CHUNK_BYTES) {
        const chunk = pcm.subarray(offset, Math.min(offset + MAX_AUDIO_CHUNK_BYTES, pcm.length));
        this.sendToRenderer("external-recording-chunk", {
          session_id: session.id,
          chunk,
          byte_length: chunk.length,
        });
      }
    }
    if (session.rendererStopped) this.dispatchRendererStop(session);
    return true;
  }

  dispatchRendererStop(session) {
    if (!session || session.done || this.rendererSessionId !== session.id || session.stopDispatched) return;
    session.stopDispatched = true;
    session.status = "processing";
    this.sendToRenderer("external-recording-stop", {
      session_id: session.id,
      paste: session.paste !== false,
      mode: session.intent,
      trigger_mode: session.mode,
      intent: session.intent,
      bytes: session.bytes,
      chunks: session.chunks,
    });
  }

  advanceRendererQueue() {
    if (this.rendererSessionId) return;
    while (this.rendererQueue.length) {
      const session = this.sessions.get(this.rendererQueue.shift());
      if (session && !session.done && this.dispatchRendererSessionIfIdle(session)) return;
    }
    const recording = [...this.sessions.values()]
      .filter((session) => !session.done && !session.rendererDispatched && session.bytes > 0)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (recording) this.dispatchRendererSessionIfIdle(recording);
  }

  sessionTimeoutReason(session, now = Date.now()) {
    if (!session || session.done || session.terminationStarted || session.status !== "recording") {
      return "";
    }
    if (now - session.createdAt >= this.recordingMaxDurationMs) {
      return "recording_duration_exceeded";
    }
    if (session.lastAudioAt) {
      const activityAt = Math.max(session.lastAudioAt, session.lastUploadAttemptAt || 0);
      return now - activityAt >= this.recordingStallTimeoutMs ? "audio_input_stalled" : "";
    }
    const firstChunkActivityAt = session.lastUploadAttemptAt || session.createdAt;
    return now - firstChunkActivityAt >= this.recordingFirstChunkTimeoutMs
      ? "first_audio_chunk_timeout"
      : "";
  }

  armSessionWatchdogs(session) {
    if (!session || session.watchdogTimer) return;
    const check = () => {
      session.watchdogTimer = null;
      if (session.done || session.terminationStarted) return;
      if (session.status !== "recording") return;
      const reason = this.sessionTimeoutReason(session);
      if (reason) {
        this.abortSession(session, reason);
        return;
      }
      session.watchdogTimer = setTimeout(check, 1000);
      session.watchdogTimer.unref?.();
    };
    session.watchdogTimer = setTimeout(check, 1000);
    session.watchdogTimer.unref?.();
  }

  abortHostTrigger(triggerId, reason = "input_device_closed") {
    const sessionId = this.hostTriggerSessions.get(triggerId);
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return this.abortSession(session, reason);
  }

  abortSession(session, reason, details = {}) {
    const recoverBluetooth = session?.captureMode === "host_capture" &&
      HOST_AUDIO_FAILURE_REASONS.has(reason) &&
      String(session?.sourceId || "").startsWith("pipewire:bluez_input.");
    if (session?.captureMode === "host_capture" && HOST_AUDIO_FAILURE_REASONS.has(reason)) {
      this.audioRouting.recordCaptureFailure(session.sourceId, reason, details);
    }
    const terminated = this.terminateSession(session, {
      reason,
      success: false,
      status: "recording_failed",
      error: reason,
      details,
    });
    if (terminated && recoverBluetooth) {
      this.queueBluetoothAudioRecovery(session, reason);
    }
    return terminated;
  }

  async waitForCaptureExit(session, timeoutMs = 2000) {
    const pid = Number(session?.capturePid || 0);
    if (!pid) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  queueBluetoothAudioRecovery(session, reason) {
    if (this.bluetoothRecoveryPending || this.bluetoothRecoveryInFlight ||
        Date.now() - this.bluetoothRecoveryLastAt < BLUETOOTH_RECOVERY_COOLDOWN_MS) {
      return false;
    }
    this.bluetoothRecoveryPending = true;
    this.waitForCaptureExit(session).then((exited) => {
      if (!exited) {
        this.logger?.warn?.("MiniJoy capture did not exit before audio recovery", {
          sourceId: session.sourceId,
          pid: session.capturePid,
        });
        this.bluetoothRecoveryPending = false;
        return;
      }
      this.bluetoothRecoveryPending = false;
      this.scheduleBluetoothAudioRecovery(session, reason);
    }).catch((error) => {
      this.bluetoothRecoveryPending = false;
      this.logger?.warn?.("Unable to wait for MiniJoy capture cleanup", {
        sourceId: session.sourceId,
        error: error?.message || String(error),
      });
    });
    return true;
  }

  scheduleBluetoothAudioRecovery(session, reason, now = Date.now()) {
    const sourceId = String(session?.sourceId || "");
    if (!sourceId.startsWith("pipewire:bluez_input.")) return false;
    if (!HOST_AUDIO_FAILURE_REASONS.has(reason)) return false;
    if (this.bluetoothRecoveryInFlight ||
        now - this.bluetoothRecoveryLastAt < BLUETOOTH_RECOVERY_COOLDOWN_MS) {
      return false;
    }
    this.bluetoothRecoveryInFlight = true;
    this.bluetoothRecoveryLastAt = now;
    const sourceDoctor = path.resolve(__dirname, "../../scripts/m5bridge-doctor.py");
    const command = fs.existsSync(sourceDoctor) ? "python3" : "m5bridge-doctor";
    const sourceMac = sourceId.match(/bluez_input\.([0-9a-f_:-]{17})/i)?.[1]
      ?.replace(/_/g, ":").toUpperCase() || "";
    const args = fs.existsSync(sourceDoctor)
      ? [sourceDoctor, "repair", "--audio-only", "--reconnect-only", "--recovery-cooldown", "60"]
      : ["repair", "--audio-only", "--reconnect-only", "--recovery-cooldown", "60"];
    if (sourceMac) args.push("--mac", sourceMac);
    this.logger?.warn?.("Recovering failed MiniJoy Bluetooth audio stack", {
      sourceId,
      reason,
    });
    this.runCommand(command, args, BLUETOOTH_RECOVERY_TIMEOUT_MS).then((result) => {
      const log = result.success ? this.logger?.info : this.logger?.warn;
      log?.call(this.logger, "MiniJoy Bluetooth audio recovery finished", {
        sourceId,
        reason,
        success: result.success,
        error: result.error || result.stderr || "",
      });
    }).finally(() => {
      this.bluetoothRecoveryInFlight = false;
    });
    return true;
  }

  terminateSession(session, result = {}) {
    if (!session || session.done || session.terminationStarted) return false;
    session.terminationStarted = true;
    if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
    session.mainAsrSession?.cancel?.();
    this.pipeWireCapture.stop(session.id);
    for (const [triggerId, sessionId] of this.hostTriggerSessions.entries()) {
      if (sessionId === session.id) this.hostTriggerSessions.delete(triggerId);
    }
    this.audioRouting.clearActiveRoute(session.triggerId);
    const wasRendererPending = this.rendererPendingSessionId === session.id;
    if (wasRendererPending) {
      this.rendererPendingSessionId = "";
    }
    if (session.rendererDispatched) {
      this.sendToRenderer("external-recording-cancel", {
        session_id: session.id,
        reason: result.reason || result.error || result.status,
      });
    } else if (wasRendererPending && !session.rendererErrorDispatched) {
      this.sendToRenderer("external-recording-cancel", {
        session_id: session.id,
        reason: result.reason || result.error || result.status,
      });
    }
    this.finishSession(session, result);
    if (wasRendererPending && !this.rendererRecovery) {
      this.advanceRendererQueue();
    }
    const hasActiveSession = [...this.sessions.values()].some((candidate) => !candidate.done);
    this.restoreUnifiedDefaultSource();
    if (!hasActiveSession) {
      this.windowManager?.hideFloatingBall?.();
    }
    return true;
  }

  abortAllSessions(reason = "bridge_recovery") {
    this.rendererRecovery = true;
    for (const session of [...this.sessions.values()]) {
      if (!session.done) this.abortSession(session, reason);
    }
    this.rendererQueue = [];
    this.rendererSessionId = "";
    this.rendererPendingSessionId = "";
    this.rendererRecovery = false;
    this.windowManager?.hideFloatingBall?.();
  }

  startCyberAgentForSession(session, payload = {}) {
    this.runCyberAgentForSession(session, payload).then((result) => {
      session.result = {
        ...(session.result || {}),
        ...result,
      };
      this.logger?.info?.("M5 cyber agent completed", {
        sessionId: session.id,
        status: result.status,
        intent: session.intent,
        agentSource: result.agent_source || null,
      });
    }).catch((error) => {
      session.result = {
        ...(session.result || {}),
        success: false,
        status: "cyber_failed",
        message: error?.message || String(error),
      };
      this.logger?.warn?.("M5 cyber agent failed", {
        sessionId: session.id,
        error: error?.message || String(error),
      });
    });
  }

  async runCyberAgentForSession(session, payload = {}) {
    const transcript = String(payload.text || payload.asr_text || "").trim();
    const audioFile = this.writeSessionWavFile(session);
    if (payload.success === false || (!transcript && !audioFile)) {
      return {
        success: false,
        status: "transcription_failed",
        intent: session.intent,
        text: transcript,
        error: payload.error || "未收到可处理的语音",
      };
    }

    const route = selectCyberAgentCommand(session.intent);
    if (!route.command) {
      return {
        success: false,
        status: "cyber_unconfigured",
        intent: session.intent,
        agent_service: route.service,
        agent_command_env: route.envName,
        text: transcript,
        message: `${route.envName} is not configured`,
      };
    }

    const request = {
      session_id: session.id,
      source: "m5stickc_plus",
      intent: session.intent,
      mode: session.mode || session.intent,
      transcript,
      text: transcript,
      bytes: session.bytes,
      chunks: session.chunks,
      audio_file: audioFile,
      audio_url: this.recordingSourceUrl(session),
      agent_service: route.service,
    };
    this.logger?.info?.("M5 cyber agent selected", {
      sessionId: session.id,
      intent: session.intent,
      service: route.service,
      commandEnv: route.envName,
      fallback: route.fallback,
    });
    const hook = await this.runShellJsonHook(route.command, request, CYBER_AGENT_TIMEOUT_MS, {
      onJsonLine: (data) => this.handleCyberAgentEvent(session, data),
    });
    if (!hook.success) {
      return {
        success: false,
        status: "cyber_failed",
        intent: session.intent,
        agent_service: route.service,
        agent_command_env: route.envName,
        text: transcript,
        message: hook.error || hook.stderr || hook.stdout || "Cyber agent failed",
      };
    }

    const agent = parseCyberAgentOutput(hook.stdout);
    if (agent.ttsAudioFile && !session.cyberTtsChunkCount) {
      this.enqueueTtsPlayback(session, {
        tts_audio_file: agent.ttsAudioFile,
        text: agent.text,
        source: agent.source,
      });
    }
    return {
      success: true,
      status: "cyber_done",
      intent: session.intent,
      text: transcript,
      agent_text: agent.text,
      tts_audio_file: agent.ttsAudioFile,
      agent_source: agent.source,
      agent_service: agent.service || route.service,
      agent_command_env: route.envName,
      message: "Cyber agent completed",
    };
  }

  handleCyberAgentEvent(session, data = {}) {
    if (data.event === "tts_chunk" && data.tts_audio_file) {
      this.enqueueTtsPlayback(session, data);
    }
  }

  enqueueTtsPlayback(session, data = {}) {
    const audioPath = String(data.tts_audio_file || data.audio_file || "").trim();
    if (!audioPath) {
      return;
    }
    const item = {
      requestId: `${session.id}-${data.index || this.ttsPlaybackQueue.length + 1}-${Date.now()}`,
      sessionId: session.id,
      audioPath,
      text: String(data.text || ""),
      source: String(data.tts_source || data.source || ""),
      index: Number(data.index || 0),
      total: Number(data.total || 0),
    };
    this.ttsPlaybackQueue.push(item);
    session.cyberTtsChunkCount = Number(session.cyberTtsChunkCount || 0) + 1;
    this.logger?.info?.("M5 TTS chunk queued", {
      sessionId: item.sessionId,
      requestId: item.requestId,
      index: item.index || null,
      total: item.total || null,
      audioPath: item.audioPath,
    });
    this.advanceTtsPlayback();
  }

  advanceTtsPlayback() {
    if (this.currentTtsPlayback || this.ttsPlaybackQueue.length === 0) {
      return;
    }
    const item = this.ttsPlaybackQueue.shift();
    this.currentTtsPlayback = item;
    this.latestTtsAudioFile = item.audioPath;
    this.ttsPlaybackRequestId = item.requestId;
    this.logger?.info?.("M5 TTS chunk ready for device", {
      sessionId: item.sessionId,
      requestId: item.requestId,
      index: item.index || null,
      total: item.total || null,
    });
  }

  completeCurrentTtsPlayback(eventName, body = {}) {
    const completed = this.currentTtsPlayback;
    this.currentTtsPlayback = null;
    this.ttsPlaybackRequestId = "";
    this.latestTtsAudioFile = "";
    this.logger?.info?.("M5 TTS playback acknowledged", {
      event: eventName,
      sessionId: body.session_id || completed?.sessionId || "",
      requestId: completed?.requestId || "",
      status: body.status || "",
    });
    this.advanceTtsPlayback();
  }

  recordingSourceUrl(session) {
    const publicBase = String(
      process.env.VIBE_STICK_BRIDGE_PUBLIC_URL ||
      process.env.M5_VOICE_BRIDGE_PUBLIC_URL ||
      ""
    ).trim().replace(/\/+$/, "");
    if (!publicBase || !session?.audioFile) {
      return "";
    }
    const params = new URLSearchParams({ session_id: session.id });
    if (this.token) {
      params.set("token", this.token);
    }
    return `${publicBase}/recording/source?${params.toString()}`;
  }

  runShellJsonHook(command, payload, timeoutMs, options = {}) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let child = null;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          ...result,
        });
      };

      const timer = setTimeout(() => {
        child?.kill?.("SIGTERM");
        finish({ success: false, error: "timeout" });
      }, timeoutMs);
      timer.unref?.();

      try {
        child = spawn(command, {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        finish({ success: false, error: error?.message || String(error) });
        return;
      }

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            options.onJsonLine?.(data);
          } catch {
            // Non-JSON stdout remains part of final hook output.
          }
        }
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        finish({ success: false, error: error?.message || String(error) });
      });
      child.on("close", (code) => {
        finish({ success: code === 0, code });
      });
      child.stdin?.end(JSON.stringify(payload));
    });
  }

  writeSessionWavFile(session) {
    if (session.audioFile) {
      return session.audioFile;
    }
    if (!session.pcmFile || !fs.existsSync(session.pcmFile)) {
      return "";
    }
    const fileName = `vibestick-${session.id.replace(/[^a-zA-Z0-9_-]/g, "") || randomUUID()}.wav`;
    const filePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(filePath, createPcmWavBuffer([fs.readFileSync(session.pcmFile)], session.sampleRate || 16000));
    session.audioFile = filePath;
    return filePath;
  }

  finishSession(session, result) {
    if (session?.watchdogTimer) {
      clearTimeout(session.watchdogTimer);
      session.watchdogTimer = null;
    }
    const completion = this.recordingSessions.finish(session, result);
    if (!completion.finished) {
      return;
    }
    this.logger?.info?.("M5 recording finished", {
      sessionId: session.id,
      status: session.status,
      bytes: session.bytes,
      chunks: session.chunks,
      success: session.result.success !== false,
    });
    if (this.rendererSessionId === session.id) {
      this.rendererSessionId = "";
      if (!this.rendererRecovery) this.advanceRendererQueue();
    }
    if (completion.pendingEnter) {
      this.scheduleFollowupKey(session, session.result, ENTER_FOLLOWUP, "queued");
    }
  }

  sendJson(res, statusCode, payload) {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }

  sendHtml(res, statusCode, body) {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    res.writeHead(statusCode, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = M5VoiceBridge;
module.exports.normalizeRecordingIntent = normalizeRecordingIntent;
module.exports.selectCyberAgentCommand = selectCyberAgentCommand;
module.exports.crc32 = crc32;
module.exports.crc32Hex = crc32Hex;
module.exports.createPcmWavBuffer = createPcmWavBuffer;
module.exports.withoutNestedBridgeState = withoutNestedBridgeState;
module.exports.diagnosticMatchesTarget = diagnosticMatchesTarget;
