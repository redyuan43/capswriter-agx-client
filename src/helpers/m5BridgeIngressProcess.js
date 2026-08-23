const http = require("http");

const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;

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

function readBody(req, limitBytes) {
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function requestHeaders(req, publicPort) {
  return {
    ...req.headers,
    host: `127.0.0.1:${process.env.M5_BRIDGE_INGRESS_INTERNAL_PORT}`,
    connection: "close",
    "x-vibe-ingress-client-ip": String(req.socket.remoteAddress || ""),
    "x-vibe-ingress-public-port": String(publicPort),
  };
}

class M5BridgeIngress {
  constructor({
    host = process.env.M5_BRIDGE_INGRESS_HOST || "0.0.0.0",
    port = Number(process.env.M5_BRIDGE_INGRESS_PORT || 8765),
    internalPort = Number(process.env.M5_BRIDGE_INGRESS_INTERNAL_PORT || 8766),
    token = cleanToken(process.env.M5_VOICE_BRIDGE_TOKEN || process.env.VIBE_STICK_BRIDGE_TOKEN),
  } = {}) {
    this.host = host;
    this.port = port;
    this.internalPort = internalPort;
    this.token = token;
    this.sessions = new Map();
    this.server = null;
  }

  log(level, message, data) {
    process.send?.({ type: "log", level, message, data });
  }

  proxy(req, body = Buffer.alloc(0)) {
    return new Promise((resolve, reject) => {
      const headers = requestHeaders(req, this.port);
      headers["content-length"] = String(body.length);
      const upstream = http.request({
        host: "127.0.0.1",
        port: this.internalPort,
        path: req.url,
        method: req.method,
        headers,
        timeout: 220000,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          statusCode: response.statusCode || 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      upstream.on("error", reject);
      upstream.on("timeout", () => {
        upstream.destroy(new Error("bridge control upstream timed out"));
      });
      upstream.end(body);
    });
  }

  writeProxyResponse(res, response) {
    const headers = {
      ...response.headers,
      connection: "close",
      "content-length": String(response.body.length),
    };
    delete headers["transfer-encoding"];
    res.writeHead(response.statusCode, headers);
    res.end(response.body);
  }

  rememberStartedSession(req, requestBody, response) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return;
    }
    let request = {};
    let payload = {};
    try {
      request = JSON.parse(requestBody.toString("utf8"));
      payload = JSON.parse(response.body.toString("utf8"));
    } catch {
      return;
    }
    const sessionId = String(payload?.recording?.session_id || request.session_id || "").trim();
    if (!sessionId) {
      return;
    }
    this.sessions.set(sessionId, {
      deviceId: String(req.headers["x-vibe-stick-device-id"] || request.device_id || "").trim(),
      protocolVersion: Math.max(1, Number(request.protocol_version || 1)),
      expectedChunkId: 0,
      bytes: 0,
      chunks: 0,
    });
  }

  async handleAudio(req, res, url) {
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const session = this.sessions.get(sessionId);
    if (!session) {
      const body = await readBody(req, MAX_AUDIO_CHUNK_BYTES);
      this.writeProxyResponse(res, await this.proxy(req, body));
      return;
    }
    if (this.token &&
        String(req.headers["x-vibe-stick-token"] || "").trim() !== this.token) {
      sendJson(res, 401, { success: false, error: "unauthorized" });
      return;
    }
    const requestDeviceId = String(req.headers["x-vibe-stick-device-id"] || "").trim();
    if (session.deviceId && requestDeviceId && session.deviceId !== requestDeviceId) {
      sendJson(res, 403, { success: false, error: "recording session belongs to another device" });
      return;
    }
    const body = await readBody(req, MAX_AUDIO_CHUNK_BYTES);
    const chunkId = String(url.searchParams.get("chunk_id") || "").trim();
    const numericChunkId = chunkId === "" ? null : Number(chunkId);
    if (session.protocolVersion >= 2) {
      if (!Number.isInteger(numericChunkId) || numericChunkId < 0) {
        sendJson(res, 400, { success: false, error: "chunk_id is required" });
        return;
      }
      if (numericChunkId > session.expectedChunkId) {
        sendJson(res, 409, {
          success: false,
          error: "audio chunk out of order",
          recording: { session_id: sessionId, expected_chunk_id: session.expectedChunkId },
        });
        return;
      }
      const expectedCrc = String(
        req.headers["x-vibe-stick-chunk-crc32"] || url.searchParams.get("chunk_crc32") || ""
      ).trim().toLowerCase().replace(/^0x/, "");
      if (!expectedCrc || expectedCrc !== crc32Hex(body)) {
        sendJson(res, 422, { success: false, error: "audio chunk checksum mismatch" });
        return;
      }
    }
    const duplicate = session.protocolVersion >= 2
      ? numericChunkId < session.expectedChunkId
      : false;
    if (!duplicate) {
      session.expectedChunkId += session.protocolVersion >= 2 ? 1 : 0;
      session.bytes += body.length;
      session.chunks += 1;
    }
    sendJson(res, 200, {
      success: true,
      recording: {
        status: "recording",
        session_id: sessionId,
        bytes: session.bytes,
        chunks: session.chunks,
        chunk_id: chunkId,
        duplicate,
        expected_chunk_id: session.expectedChunkId,
      },
    });
    if (!duplicate) {
      process.send?.({
        type: "recording-audio",
        payload: {
          session_id: sessionId,
          chunk_id: numericChunkId,
          audio: body,
        },
      });
    }
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/recording/audio") {
      await this.handleAudio(req, res, url);
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD"
      ? Buffer.alloc(0)
      : await readBody(req, MAX_JSON_BYTES);
    const response = await this.proxy(req, body);
    if (req.method === "POST" && url.pathname === "/recording/start") {
      this.rememberStartedSession(req, body, response);
    }
    if (req.method === "POST" && url.pathname === "/recording/stop") {
      try {
        const payload = JSON.parse(body.toString("utf8"));
        this.sessions.delete(String(payload.session_id || "").trim());
      } catch {
        // The upstream response remains authoritative for malformed requests.
      }
    }
    this.writeProxyResponse(res, response);
  }

  start() {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log("warn", "M5 ingress request failed", {
          method: req.method,
          url: req.url,
          error: error?.message || String(error),
        });
        sendJson(res, error.statusCode || 502, {
          success: false,
          error: error?.message || "bridge ingress failed",
        });
      });
    });
    this.server.listen(this.port, this.host, () => {
      this.log("info", "M5 ingress listening", {
        host: this.host,
        port: this.server.address().port,
        internalPort: this.internalPort,
      });
      process.send?.({ type: "ready", port: this.server.address().port });
    });
  }

  stop() {
    this.server?.close(() => process.exit(0));
  }
}

const ingress = new M5BridgeIngress();
ingress.start();
process.on("message", (message) => {
  if (message?.type === "shutdown") {
    ingress.stop();
  }
});
