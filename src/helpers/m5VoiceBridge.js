const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const STOP_WAIT_MS = 210000;
const CYBER_AGENT_TIMEOUT_MS = 180000;
const MAX_TTS_AUDIO_BYTES = 1024 * 1024;
const ENTER_KEY_SETTLE_MS = 120;
const OTA_BOARDS = new Set(["sticks3", "stickc_plus"]);
const DEVICE_RETENTION_MS = 24 * 60 * 60 * 1000;
const FOLLOWUP_KEYS = {
  enter: {
    name: "enter",
    keyName: "Return",
    pendingField: "pendingEnter",
    sentField: "enterSent",
    dispatchingField: "enterDispatching",
    requirePaste: true,
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function defaultOtaDir() {
  const repoRoot = path.resolve(__dirname, "../..");
  const candidates = [
    path.resolve(repoRoot, "../VibeStick-multi-bridge/firmware/sticks3/ota"),
    path.resolve(repoRoot, "../VibeStick/firmware/sticks3/ota"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function safeOtaBoard(value) {
  const board = String(value || "").trim();
  return OTA_BOARDS.has(board) ? board : "";
}

function readOtaManifest(otaDir, board) {
  const safeBoard = safeOtaBoard(board);
  if (!safeBoard) {
    return null;
  }
  const manifestPath = path.join(otaDir, `${safeBoard}.json`);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

class M5VoiceBridge {
  constructor({ logger, windowManager, clipboardManager, sendToRenderer }) {
    this.logger = logger;
    this.windowManager = windowManager;
    this.clipboardManager = clipboardManager;
    this.sendToRenderer = sendToRenderer;
    this.server = null;
    this.sessions = new Map();
    this.devices = new Map();
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
    this.otaDir = process.env.M5_VOICE_BRIDGE_OTA_DIR || process.env.VIBE_STICK_OTA_DIR || defaultOtaDir();
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
    this.server.close();
    this.server = null;
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    this.rememberDevice(req, url.pathname);
    if (req.method === "GET" && url.pathname === "/health") {
      this.requireToken(req);
      this.sendJson(res, 200, this.healthPayload());
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      this.sendJson(res, 200, this.buildState());
      return;
    }
    if (req.method === "GET" && url.pathname === "/devices") {
      this.sendJson(res, 200, { devices: this.listDevices() });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      this.sendHtml(res, 200, this.buildDashboardHtml());
      return;
    }
    if (req.method === "GET" && url.pathname === "/ota/manifest") {
      this.handleOtaManifest(res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/ota/bin") {
      this.handleOtaBinary(res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/recording/tts") {
      this.handleRecordingTts(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/recording/source") {
      this.handleRecordingSource(res, url);
      return;
    }
    if (req.method !== "POST") {
      this.sendJson(res, 405, { success: false, error: "method not allowed" });
      return;
    }
    this.requireToken(req);
    if (url.pathname === "/event" || url.pathname === "/quota/refresh") {
      await this.handleEvent(req, res);
      return;
    }
    if (url.pathname === "/recording/start") {
      await this.handleRecordingStart(req, res);
      return;
    }
    if (url.pathname === "/recording/audio") {
      await this.handleRecordingAudio(req, res, url);
      return;
    }
    if (url.pathname === "/recording/stop") {
      await this.handleRecordingStop(req, res);
      return;
    }
    this.sendJson(res, 404, { success: false, error: "not found" });
  }

  rememberDevice(req, requestPath) {
    const firmwareName = String(req.headers["x-vibe-stick-firmware-name"] || "").trim();
    const deviceId = String(req.headers["x-vibe-stick-device-id"] || "").trim();
    if (!firmwareName && !deviceId) {
      return;
    }

    const now = Date.now();
    const clientIp = normalizeRemoteAddress(req.socket?.remoteAddress || "");
    const key = deviceId || clientIp || "unknown-device";
    const previous = this.devices.get(key) || {};
    const device = {
      device_id: key,
      client_ip: clientIp,
      path: requestPath,
      last_seen: now,
      last_seen_text: new Date(now).toLocaleString(),
      firmware_name: firmwareName,
      firmware_version: String(req.headers["x-vibe-stick-firmware-version"] || ""),
      transport: String(req.headers["x-vibe-stick-firmware-transport"] || ""),
      build_date: String(req.headers["x-vibe-stick-firmware-build-date"] || ""),
      board: String(req.headers["x-vibe-stick-board"] || ""),
      device_ip: String(req.headers["x-vibe-stick-device-ip"] || clientIp),
      wifi_ssid: String(req.headers["x-vibe-stick-wifi-ssid"] || ""),
      wifi_bssid: String(req.headers["x-vibe-stick-wifi-bssid"] || ""),
      wifi_rssi: parseInteger(req.headers["x-vibe-stick-wifi-rssi"], previous.wifi_rssi ?? null),
    };
    this.devices.set(key, device);
    this.pruneDevices(now);
  }

  pruneDevices(now = Date.now()) {
    for (const [key, device] of this.devices.entries()) {
      if (now - Number(device.last_seen || 0) > DEVICE_RETENTION_MS) {
        this.devices.delete(key);
      }
    }
  }

  listDevices() {
    this.pruneDevices();
    return [...this.devices.values()].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  }

  buildDashboardHtml() {
    const devices = this.listDevices();
    const rows = devices.map((device) => this.deviceRowHtml(device)).join("");
    const bodyRows = rows || '<tr><td colspan="8" class="empty">No M5Stack devices seen yet.</td></tr>';
    const updatedAt = escapeHtml(new Date().toLocaleString());
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>CapsWriter M5 Bridge</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; }
main { max-width: 1120px; margin: 0 auto; padding: 28px 20px; }
h1 { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
.meta { color: #94a3b8; margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; background: #1e293b; border: 1px solid #334155; }
th, td { padding: 10px 12px; border-bottom: 1px solid #334155; text-align: left; font-size: 14px; white-space: nowrap; }
th { color: #cbd5e1; background: #111827; font-weight: 600; }
.empty { color: #94a3b8; text-align: center; padding: 24px; }
.muted { color: #94a3b8; }
.ok { color: #86efac; }
.warn { color: #fde68a; }
.bad { color: #fca5a5; }
</style>
</head>
<body>
<main>
<h1>CapsWriter M5 Bridge</h1>
<div class="meta">${escapeHtml(this.bridgeLabel)} (${escapeHtml(this.bridgeId)}) &middot; Listening on ${escapeHtml(this.host)}:${this.port} &middot; Updated ${updatedAt}</div>
<table>
<thead>
<tr><th>Device</th><th>IP</th><th>Board</th><th>Firmware</th><th>WiFi</th><th>RSSI</th><th>Last Seen</th><th>Path</th></tr>
</thead>
<tbody>${bodyRows}</tbody>
</table>
</main>
</body>
</html>`;
  }

  deviceRowHtml(device) {
    const rssi = device.wifi_rssi;
    const rssiClass = rssi === null || rssi === undefined ? "muted" : rssi >= -67 ? "ok" : rssi < -75 ? "bad" : "warn";
    const firmware = [device.firmware_name, device.firmware_version].filter(Boolean).join(" ");
    const buildDate = String(device.build_date || "").trim();
    const firmwareText = buildDate ? `${firmware} (${buildDate})` : firmware;
    return `<tr>
<td>${escapeHtml(device.device_id)}</td>
<td>${escapeHtml(device.device_ip || device.client_ip)}</td>
<td>${escapeHtml(device.board)}</td>
<td>${escapeHtml(firmwareText)}</td>
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
      await this.handleFollowupKey(body, res, FOLLOWUP_KEYS.enter);
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
    const board = safeOtaBoard(url.searchParams.get("board"));
    if (!board) {
      this.sendJson(res, 200, { available: false, error: "unknown board" });
      return;
    }
    const manifest = readOtaManifest(this.otaDir, board);
    if (!manifest) {
      this.sendJson(res, 200, { available: false, board });
      return;
    }
    this.sendJson(res, 200, {
      ...manifest,
      available: Boolean(manifest.available ?? true),
      board,
      url: manifest.url || `/ota/bin?board=${board}`,
    });
  }

  handleOtaBinary(res, url) {
    const board = safeOtaBoard(url.searchParams.get("board"));
    const manifest = readOtaManifest(this.otaDir, board);
    if (!board || !manifest) {
      this.sendJson(res, 404, { success: false, error: "OTA image not found" });
      return;
    }
    const fileName = path.basename(String(manifest.file_name || `${board}.bin`));
    const binaryPath = path.join(this.otaDir, fileName);
    let stat;
    try {
      stat = fs.statSync(binaryPath);
    } catch {
      this.sendJson(res, 404, { success: false, error: "OTA image not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(binaryPath).pipe(res);
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
    const active = [...this.sessions.values()].find((session) => !session.done);
    if (!active) {
      return { status: "idle", session_id: "" };
    }
    return {
      status: active.status,
      session_id: active.id,
      source: "m5stickc_plus",
      intent: active.intent || "dictation",
    };
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

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger?.warn?.(`M5 follow-up ${options.name} ignored: session not found`, { sessionId });
      this.sendJson(res, 200, {
        success: false,
        [responseKey]: { status: "session_not_found", session_id: sessionId },
      });
      return;
    }

    if (session.done) {
      this.logger?.info?.(`M5 follow-up ${options.name} rejected: session completed`, {
        sessionId,
        status: session.status,
      });
      this.sendJson(res, 200, {
        success: false,
        [responseKey]: { status: "session_completed", session_id: sessionId },
      });
      return;
    }

    session[options.pendingField] = true;
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

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger?.warn?.("M5 follow-up cancel ignored: session not found", { sessionId });
      this.sendJson(res, 200, {
        success: false,
        followup_escape: { status: "session_not_found", session_id: sessionId },
      });
      return;
    }

    if (session.done) {
      this.logger?.info?.("M5 follow-up cancel rejected: session completed", {
        sessionId,
        status: session.status,
      });
      this.sendJson(res, 200, {
        success: false,
        followup_escape: { status: "session_completed", session_id: sessionId },
      });
      return;
    }

    session.cancelRequested = true;
    session.pendingEnter = false;
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

  isPasteSuccess(result = {}, session = {}) {
    const status = String(result.status || session.status || "").trim();
    return result.success !== false && status === "pasted";
  }

  async sendKeyForSession(session, result = {}, options, reason = "queued") {
    if (!session) {
      return { success: false, status: "session_not_found", reason };
    }
    if (session[options.sentField]) {
      return { success: true, status: "already_sent", reason };
    }
    if (options.requirePaste && !this.isPasteSuccess(result, session)) {
      this.logger?.info?.(`M5 follow-up ${options.name} skipped: paste did not succeed`, {
        sessionId: session.id,
        status: result.status || session.status,
        success: result.success !== false,
        reason,
      });
      return { success: false, status: "paste_not_successful", reason };
    }
    if (!session.targetWindowId) {
      this.logger?.warn?.(`M5 follow-up ${options.name} skipped: no target window`, {
        sessionId: session.id,
        reason,
      });
      return { success: false, status: "no_target_window", reason };
    }
    if (process.platform !== "linux") {
      this.logger?.warn?.(`M5 follow-up ${options.name} unsupported on this platform`, {
        sessionId: session.id,
        platform: process.platform,
        reason,
      });
      return { success: false, status: "unsupported_platform", reason };
    }

    const targetWindowId = String(session.targetWindowId);
    const activate = await this.runCommand("xdotool", ["windowactivate", "--sync", targetWindowId], 2000);
    if (!activate.success) {
      this.logger?.warn?.(`M5 follow-up ${options.name} failed to activate target window`, {
        sessionId: session.id,
        targetWindowId,
        error: activate.error || activate.stderr,
        reason,
      });
      return { success: false, status: "activate_failed", reason };
    }

    await sleep(ENTER_KEY_SETTLE_MS);
    const key = await this.runCommand("xdotool", ["key", "--delay", "35", options.keyName], 1500);
    if (!key.success) {
      this.logger?.warn?.(`M5 follow-up ${options.name} failed to send ${options.keyName}`, {
        sessionId: session.id,
        targetWindowId,
        error: key.error || key.stderr,
        reason,
      });
      return { success: false, status: "send_failed", reason };
    }

    session[options.sentField] = true;
    this.logger?.info?.(`M5 follow-up ${options.name} sent`, {
      sessionId: session.id,
      targetWindowId,
      keyName: options.keyName,
      reason,
    });
    return { success: true, status: "sent", reason };
  }

  scheduleFollowupKey(session, result = {}, options, reason = "queued") {
    if (!session || session[options.sentField] || session[options.dispatchingField]) {
      return;
    }
    session[options.dispatchingField] = true;
    setImmediate(() => {
      this.sendKeyForSession(session, result, options, reason).catch((error) => {
        this.logger?.warn?.(`M5 follow-up ${options.name} failed`, {
          sessionId: session.id,
          error: error?.message || String(error),
        });
      }).finally(() => {
        session[options.dispatchingField] = false;
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
    const session = {
      id: sessionId,
      status: "recording",
      intent,
      mode,
      bytes: 0,
      chunks: 0,
      audioChunks: [],
      sampleRate: 16000,
      audioFile: "",
      done: false,
      createdAt: Date.now(),
      targetWindowId: "",
      pendingEnter: false,
      enterSent: false,
      enterDispatching: false,
      cancelRequested: false,
      result: null,
      resolver: null,
      stopTimer: null,
    };
    this.sessions.set(sessionId, session);
    this.windowManager?.showFloatingBall?.();
    session.targetWindowId = String(this.windowManager?.previousActiveWindow || "").trim();
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
    this.logger?.info?.("M5 recording started", {
      sessionId,
      intent,
      mode,
      targetWindowId: session.targetWindowId || null,
    });
    this.sendJson(res, 200, {
      success: true,
      recording: { status: "recording", session_id: sessionId, intent },
      state: this.buildState(),
    });
  }

  async handleRecordingAudio(req, res, url) {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session || session.done) {
      this.sendJson(res, 404, { success: false, error: "recording session not found" });
      return;
    }
    const body = await readRequestBody(req, MAX_AUDIO_CHUNK_BYTES);
    if (body.length > 0) {
      session.bytes += body.length;
      session.chunks += 1;
      session.audioChunks.push(Buffer.from(body));
      const chunk = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      this.sendToRenderer("external-recording-chunk", {
        session_id: sessionId,
        chunk,
        byte_length: body.length,
      });
    }
    this.sendJson(res, 200, {
      success: true,
      recording: {
        status: "recording",
        session_id: sessionId,
        bytes: session.bytes,
        chunks: session.chunks,
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

  latestSessionId() {
    const sessions = [...this.sessions.values()].filter((session) => !session.done);
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    return sessions[0]?.id || "";
  }

  waitForSessionResult(session) {
    return new Promise((resolve) => {
      session.resolver = resolve;
      session.stopTimer = setTimeout(() => {
        this.finishSession(session, {
          success: false,
          status: "transcription_failed",
          error: "Timed out waiting for CapsWriter renderer",
        });
      }, STOP_WAIT_MS);
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
    if (!session || session.done) {
      return;
    }
    session.result = result || {};
    session.done = true;
    session.status = session.result.status || (session.result.success === false ? "transcription_failed" : "pasted");
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    if (session.resolver) {
      session.resolver(session.result);
      session.resolver = null;
    }
    this.logger?.info?.("M5 recording finished", {
      sessionId: session.id,
      status: session.status,
      bytes: session.bytes,
      chunks: session.chunks,
      success: session.result.success !== false,
    });
    if (session.pendingEnter) {
      this.scheduleFollowupKey(session, session.result, FOLLOWUP_KEYS.enter, "queued");
    }
    const cleanupTimer = setTimeout(() => this.sessions.delete(session.id), 60000);
    cleanupTimer.unref?.();
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

function normalizeRemoteAddress(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
