const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8765;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const STOP_WAIT_MS = 28000;
const OTA_BOARDS = new Set(["sticks3", "stickc_plus"]);
const DEVICE_RETENTION_MS = 24 * 60 * 60 * 1000;

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

function defaultOtaDir() {
  const repoRoot = path.resolve(__dirname, "../..");
  return path.resolve(repoRoot, "../VibeStick/firmware/sticks3/ota");
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
    this.otaDir = process.env.M5_VOICE_BRIDGE_OTA_DIR || process.env.VIBE_STICK_OTA_DIR || defaultOtaDir();
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
      this.sendJson(res, 200, {
        ok: true,
        bridge_name: "capswriter-m5-voice-bridge",
        bridge_version: "1.0.0",
      });
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
    if (req.method !== "POST") {
      this.sendJson(res, 405, { success: false, error: "method not allowed" });
      return;
    }
    this.requireToken(req);
    if (url.pathname === "/event" || url.pathname === "/quota/refresh") {
      await readRequestBody(req, MAX_JSON_BYTES);
      this.sendJson(res, 200, this.buildState());
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
<div class="meta">Listening on ${escapeHtml(this.host)}:${this.port} &middot; Updated ${updatedAt}</div>
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
    return `<tr>
<td>${escapeHtml(device.device_id)}</td>
<td>${escapeHtml(device.device_ip || device.client_ip)}</td>
<td>${escapeHtml(device.board)}</td>
<td>${escapeHtml(firmware)}</td>
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
      bridge_name: "capswriter-m5-voice-bridge",
      bridge_version: "1.0.0",
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

  currentRecordingState() {
    const active = [...this.sessions.values()].find((session) => !session.done);
    if (!active) {
      return { status: "idle", session_id: "" };
    }
    return {
      status: active.status,
      session_id: active.id,
      source: "m5stickc_plus",
    };
  }

  async handleRecordingStart(req, res) {
    const body = parseJson(await readRequestBody(req, MAX_JSON_BYTES));
    const sessionId = String(body.session_id || randomUUID().replace(/-/g, "")).trim();
    const session = {
      id: sessionId,
      status: "recording",
      bytes: 0,
      chunks: 0,
      done: false,
      createdAt: Date.now(),
      targetWindowId: "",
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
      mode: "dictation",
    });
    this.logger?.info?.("M5 recording started", {
      sessionId,
      targetWindowId: session.targetWindowId || null,
    });
    this.sendJson(res, 200, {
      success: true,
      recording: { status: "recording", session_id: sessionId },
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
    if (!session || session.done) {
      this.sendJson(res, 404, {
        success: false,
        recording: { status: "stop_failed", session_id: sessionId },
        error: "recording session not found",
      });
      return;
    }
    session.status = "processing";
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
      paste: body.paste !== false,
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

  handleRendererResult(payload = {}) {
    const sessionId = String(payload.session_id || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: "recording session not found" };
    }
    this.finishSession(session, payload);
    return { success: true };
  }

  finishSession(session, result) {
    if (!session || session.done) {
      return;
    }
    session.done = true;
    session.status = result.status || (result.success === false ? "transcription_failed" : "pasted");
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    if (session.resolver) {
      session.resolver(result);
      session.resolver = null;
    }
    this.logger?.info?.("M5 recording finished", {
      sessionId: session.id,
      status: session.status,
      bytes: session.bytes,
      chunks: session.chunks,
      success: result.success !== false,
    });
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
