const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

function request(port, pathname, { method = "POST", headers = {}, body = Buffer.alloc(0) } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        "Content-Length": body.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function waitForMessage(child, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("timed out waiting for child message"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

test("ingress acknowledges known recording chunks without waiting for the control process", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/recording/start") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const payload = Buffer.from(JSON.stringify({
        success: true,
        recording: { session_id: body.session_id },
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": payload.length });
      res.end(payload);
      return;
    }
    res.writeHead(500);
    res.end("audio should not be proxied");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = upstream.address().port;
  const entry = path.join(__dirname, "../src/helpers/m5BridgeIngressProcess.js");
  const child = fork(entry, [], {
    env: {
      ...process.env,
      M5_BRIDGE_INGRESS_HOST: "127.0.0.1",
      M5_BRIDGE_INGRESS_PORT: "0",
      M5_BRIDGE_INGRESS_INTERNAL_PORT: String(upstreamPort),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const ready = await waitForMessage(child, (message) => message?.type === "ready");
  const port = ready.port;
  t.after(() => {
    child.send({ type: "shutdown" });
    upstream.close();
  });

  const sessionId = "ingress-session";
  const start = await request(port, "/recording/start", {
    body: Buffer.from(JSON.stringify({ session_id: sessionId, protocol_version: 1 })),
  });
  assert.equal(start.statusCode, 200);

  const audioMessage = waitForMessage(
    child,
    (message) => message?.type === "recording-audio"
  );
  const startedAt = Date.now();
  const audio = await request(port, `/recording/audio?session_id=${sessionId}&chunk_id=0`, {
    headers: { "X-Vibe-Stick-Device-Id": "device-a" },
    body: Buffer.alloc(3840, 3),
  });
  assert.equal(audio.statusCode, 200);
  assert.ok(Date.now() - startedAt < 100);
  const message = await audioMessage;
  assert.equal(message.type, "recording-audio");
  assert.equal(message.payload.session_id, sessionId);
  assert.ok(Buffer.isBuffer(message.payload.audio));
  assert.equal(message.payload.audio.length, 3840);
});
