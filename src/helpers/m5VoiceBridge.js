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
const { ENTER_FOLLOWUP } = require("./m5FollowupKeyDispatcher");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const STOP_WAIT_MS = 210000;
const CYBER_AGENT_TIMEOUT_MS = 180000;
const MAX_TTS_AUDIO_BYTES = 1024 * 1024;
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
  constructor({ logger, windowManager, clipboardManager, databaseManager, sendToRenderer }) {
    this.logger = logger;
    this.windowManager = windowManager;
    this.clipboardManager = clipboardManager;
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
    this.hostTriggerSessions = new Map();
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
    for (const session of this.sessions.values()) {
      this.finishSession(session, {
        success: false,
        status: "bridge_stopped",
        error: "M5 voice bridge stopped",
      });
    }
    this.pipeWireCapture.stopAll();
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
    return this.deviceRegistry.list();
  }

  buildDashboardHtml() {
    const devices = this.listDevices();
    const rows = devices.map((device) => this.deviceRowHtml(device)).join("");
    const bodyRows = rows || '<tr><td colspan="9" class="empty">No M5Stack devices seen yet.</td></tr>';
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
.route-grid { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(260px, 2fr); gap: 10px 16px; align-items: center; }
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
<h2>在线设备</h2>
<table>
<thead>
<tr><th>Device</th><th>IP</th><th>Board</th><th>Firmware</th><th>Wake</th><th>WiFi</th><th>RSSI</th><th>Last Seen</th><th>Path</th></tr>
</thead>
<tbody>${bodyRows}</tbody>
</table>
</main>
<script>
const state = ${routingState};
const routeRoot = document.getElementById("routes");
const triggerLabel = (id) => id === "keyboard" ? "键盘按键" : id === "minijoy_bt" ? "MiniJoy 蓝牙按键" : "WiFi 设备 " + id.slice(5);
for (const [triggerId, route] of Object.entries(state.routes)) {
  const label = document.createElement("label");
  label.textContent = triggerLabel(triggerId);
  label.htmlFor = "route-" + triggerId;
  const select = document.createElement("select");
  select.id = "route-" + triggerId;
  select.dataset.triggerId = triggerId;
  for (const source of state.sources) {
    const option = document.createElement("option");
    option.value = source.source_id;
    option.textContent = source.name + (source.online ? "" : "（离线）");
    option.selected = source.source_id === route.source_id;
    select.appendChild(option);
  }
  routeRoot.append(label, select);
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
      body: JSON.stringify({ version: 1, routes }),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    status.textContent = "已保存";
  } catch (error) {
    status.textContent = "保存失败：" + error.message;
  }
});
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

  requireToken(req) {
    if (!this.token) {
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
    return {
      time: new Date().toISOString(),
      wifi: true,
      ble: false,
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
    this.sendToRenderer("external-recording-cancel", {
      session_id: sessionId,
      reason: "button_followup_escape",
    });
    this.finishSession(session, {
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
    const route = this.audioRouting.activateTrigger(triggerId);
    const requestingSourceId = req.vibeDevice?.device_id
      ? `wifi:${req.vibeDevice.device_id}`
      : triggerId;
    const sourceId = route.source_id || requestingSourceId || triggerId;
    const captureMode = sourceId === requestingSourceId
      ? "device_upload"
      : sourceId.startsWith("wifi:")
        ? "remote_device"
        : "host_capture";
    this.windowManager?.showFloatingBall?.();
    const targetWindowId = String(this.windowManager?.previousActiveWindow || "").trim();
    const session = this.recordingSessions.create({
      id: sessionId,
      intent,
      mode,
      targetWindowId,
    });
    session.triggerId = triggerId;
    session.sourceId = sourceId;
    session.captureMode = captureMode;
    session.sourceDeviceId = sourceId.startsWith("wifi:") ? sourceId.slice(5) : "";
    session.seenChunkIds = new Set();
    this.sendToRenderer("external-recording-start", {
      session_id: sessionId,
      source: body.source || "m5stickc_plus",
      audio_source: body.audio_source || "stickc_plus_pcm",
      sample_rate: 16000,
      bits_per_sample: 16,
      channels: 1,
      mode: intent,
      trigger_mode: mode,
      intent,
    });
    if (captureMode === "host_capture") {
      this.pipeWireUnifiedSource.activate(route.source.node_name);
      this.pipeWireCapture.start(
        sessionId,
        sourceId,
        (chunk) => this.appendRecordingAudio(session, chunk),
        route.source.node_name
      );
    } else if (captureMode === "remote_device") {
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
    this.sendJson(res, 200, {
      success: true,
      recording: {
        status: "recording",
        session_id: sessionId,
        intent,
        capture_mode: captureMode,
        source_id: sourceId,
        audio_format: {
          codec: "pcm_s16le",
          sample_rate: 16000,
          channels: 1,
        },
      },
      state: this.buildState(),
    });
  }

  appendRecordingAudio(session, body) {
    if (!this.recordingSessions.appendAudio(session, body)) {
      return false;
    }
    const chunk = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    this.sendToRenderer("external-recording-chunk", {
      session_id: session.id,
      chunk,
      byte_length: body.length,
    });
    return true;
  }

  async handleRecordingAudio(req, res, url) {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const chunkId = String(url.searchParams.get("chunk_id") || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session || session.done) {
      this.sendJson(res, 404, { success: false, error: "recording session not found" });
      return;
    }
    const body = await readRequestBody(req, MAX_AUDIO_CHUNK_BYTES);
    const duplicate = Boolean(chunkId && session.seenChunkIds?.has(chunkId));
    if (!duplicate) {
      if (chunkId) session.seenChunkIds?.add(chunkId);
      this.appendRecordingAudio(session, body);
    }
    this.sendJson(res, 200, {
      success: true,
      recording: {
        status: "recording",
        session_id: sessionId,
        bytes: session.bytes,
        chunks: session.chunks,
        chunk_id: chunkId,
        duplicate,
      },
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
    if (session.done) {
      if (session.status === "cancelled") {
        this.sendJson(res, 200, {
          success: true,
          recording: {
            status: "cancelled",
            session_id: sessionId,
            transcript: "",
            intent: session.intent,
            message: session.result?.message || "External M5 recording cancelled",
          },
          state: this.buildState(),
        });
        return;
      }
      this.sendJson(res, 404, {
        success: false,
        recording: { status: "stop_failed", session_id: sessionId },
        error: "recording session already completed",
      });
      return;
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
    session.status = "processing";
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
    this.sendToRenderer("external-recording-stop", {
      session_id: sessionId,
      paste,
      mode: session.intent,
      trigger_mode: session.mode,
      intent: session.intent,
      bytes: session.bytes,
      chunks: session.chunks,
    });

    const result = await this.waitForSessionResult(session);
    this.sendJson(res, 200, {
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
      state: this.buildState(),
    });
  }

  getAudioRoutingState() {
    return this.audioRouting.getState();
  }

  async handleAudioRoutingUpdate(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    this.audioRouting.saveRoutes(body);
    this.sendJson(res, 200, {
      success: true,
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

  async handleHostTriggerDown(triggerId, targetWindowId = "") {
    const route = this.audioRouting.activateTrigger(triggerId);
    if (!route.source_id.startsWith("wifi:")) {
      if (route.available && route.source.node_name) {
        this.pipeWireUnifiedSource.activate(route.source.node_name);
      }
      if (triggerId !== "minijoy_bt" || !route.available || !route.source.node_name) {
        return { handled: false, route };
      }

      const sessionId = randomUUID().replace(/-/g, "");
      const session = this.createHostRecordingSession({
        sessionId,
        triggerId,
        route,
        targetWindowId,
        captureMode: "host_capture",
      });
      this.pipeWireCapture.start(
        sessionId,
        route.source_id,
        (chunk) => this.appendRecordingAudio(session, chunk),
        route.source.node_name
      );
      return { handled: true, route, session_id: sessionId };
    }

    const sessionId = randomUUID().replace(/-/g, "");
    const sourceDeviceId = route.source_id.slice(5);
    const session = this.createHostRecordingSession({
      sessionId,
      triggerId,
      route,
      targetWindowId,
      captureMode: "remote_device",
      sourceDeviceId,
    });
    this.commandBroker.enqueue(sourceDeviceId, {
      type: "recording_start",
      payload: {
        session_id: sessionId,
        trigger_id: triggerId,
        intent: "dictation",
        mode: "dictation",
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
  }) {
    const session = this.recordingSessions.create({
      id: sessionId,
      intent: "dictation",
      mode: "dictation",
      targetWindowId,
    });
    Object.assign(session, {
      triggerId,
      sourceId: route.source_id,
      sourceDeviceId,
      captureMode,
      seenChunkIds: new Set(),
    });
    this.hostTriggerSessions.set(triggerId, sessionId);
    this.sendToRenderer("external-recording-start", {
      session_id: sessionId,
      source: "audio_router",
      audio_source: route.source_id,
      sample_rate: 16000,
      bits_per_sample: 16,
      channels: 1,
      mode: "dictation",
      trigger_mode: "dictation",
      intent: "dictation",
    });
    return session;
  }

  async handleHostTriggerUp(triggerId) {
    const sessionId = this.hostTriggerSessions.get(triggerId);
    if (!sessionId) {
      this.audioRouting.clearActiveRoute(triggerId);
      return { handled: false };
    }
    this.hostTriggerSessions.delete(triggerId);
    const session = this.sessions.get(sessionId);
    if (!session || session.done) {
      return { handled: true, session_id: sessionId };
    }
    let acknowledgement = null;
    if (session.captureMode === "host_capture") {
      this.pipeWireCapture.stop(sessionId);
    } else {
      const command = this.commandBroker.enqueue(session.sourceDeviceId, {
        type: "recording_stop",
        payload: { session_id: sessionId },
      });
      acknowledgement = await this.commandBroker.waitForAcknowledgement(
        session.sourceDeviceId,
        command.command_id
      );
      if (!acknowledgement || acknowledgement.status !== "completed") {
        this.logger?.warn?.("Host-triggered remote audio stop was not acknowledged", {
          sessionId,
          deviceId: session.sourceDeviceId,
          acknowledgement,
        });
      }
    }
    session.status = "processing";
    this.sendToRenderer("external-recording-stop", {
      session_id: sessionId,
      paste: true,
      mode: session.intent,
      trigger_mode: session.mode,
      intent: session.intent,
      bytes: session.bytes,
      chunks: session.chunks,
    });
    this.audioRouting.clearActiveRoute(triggerId);
    return { handled: true, session_id: sessionId, acknowledgement };
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
    this.finishSession(session, payload);
    return { success: true };
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
    if (!session.audioChunks?.length) {
      return "";
    }
    const fileName = `vibestick-${session.id.replace(/[^a-zA-Z0-9_-]/g, "") || randomUUID()}.wav`;
    const filePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(filePath, createPcmWavBuffer(session.audioChunks, session.sampleRate || 16000));
    session.audioFile = filePath;
    return filePath;
  }

  finishSession(session, result) {
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
module.exports.createPcmWavBuffer = createPcmWavBuffer;
