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
}

module.exports = M5VoiceBridge;
