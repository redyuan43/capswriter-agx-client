const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const {
  IMA_ADPCM_BLOCK_BYTES,
  IMA_ADPCM_CONTENT_TYPE,
  PCM_BYTES_PER_BLOCK,
} = require("../src/helpers/imaAdpcm");

function crc32Hex(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function constantAdpcmBlock(sample) {
  const block = Buffer.alloc(IMA_ADPCM_BLOCK_BYTES);
  block.writeInt16LE(sample, 0);
  return block;
}

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
        recording: {
          session_id: body.session_id,
          accepted_transport_encoding:
            body.transport_encoding === "ima-adpcm-v1"
              ? "ima-adpcm-v1"
              : "pcm16",
        },
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": payload.length });
      res.end(payload);
      return;
    }
    if (req.url === "/recording/stop") {
      const payload = Buffer.from(JSON.stringify({
        success: true,
        recording: { status: "stopped" },
      }));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      });
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

  const adpcmSessionId = "ingress-adpcm-session";
  const deviceHeaders = { "X-Vibe-Stick-Device-Id": "cardputer-a" };
  const adpcmStart = await request(port, "/recording/start", {
    headers: deviceHeaders,
    body: Buffer.from(JSON.stringify({
      session_id: adpcmSessionId,
      device_id: "cardputer-a",
      protocol_version: 2,
      transport_encoding: "ima-adpcm-v1",
    })),
  });
  assert.equal(adpcmStart.statusCode, 200);

  const encoded = Buffer.concat([
    constantAdpcmBlock(1234),
    constantAdpcmBlock(-2345),
  ]);
  const adpcmMessage = waitForMessage(
    child,
    (candidate) => candidate?.type === "recording-audio" &&
      candidate?.payload?.session_id === adpcmSessionId
  );
  const adpcmResponse = await request(
    port,
    `/recording/audio?session_id=${adpcmSessionId}&chunk_id=0`,
    {
      headers: {
        ...deviceHeaders,
        "Content-Type": IMA_ADPCM_CONTENT_TYPE,
        "X-Vibe-Stick-Audio-Encoding": "ima-adpcm-v1",
        "X-Vibe-Stick-Audio-Sample-Rate": "16000",
        "X-Vibe-Stick-Audio-Channels": "1",
        "X-Vibe-Stick-Audio-Block-Samples": "960",
        "X-Vibe-Stick-Chunk-CRC32": crc32Hex(encoded),
      },
      body: encoded,
    }
  );
  assert.equal(adpcmResponse.statusCode, 200);
  assert.equal(
    JSON.parse(adpcmResponse.body).recording.bytes,
    2 * PCM_BYTES_PER_BLOCK
  );
  const decodedMessage = await adpcmMessage;
  assert.equal(decodedMessage.payload.transport_encoding, "ima-adpcm-v1");
  assert.equal(decodedMessage.payload.wire_bytes, encoded.length);
  assert.equal(decodedMessage.payload.audio.length, 2 * PCM_BYTES_PER_BLOCK);
  assert.equal(decodedMessage.payload.audio.readInt16LE(0), 1234);
  assert.equal(
    decodedMessage.payload.audio.readInt16LE(PCM_BYTES_PER_BLOCK),
    -2345
  );

  const drainMessage = waitForMessage(
    child,
    (candidate) => candidate?.type === "recording-drain" &&
      candidate?.session_id === adpcmSessionId
  );
  const stopPromise = request(port, "/recording/stop", {
    headers: deviceHeaders,
    body: Buffer.from(JSON.stringify({ session_id: adpcmSessionId })),
  });
  const drain = await drainMessage;
  child.send({
    type: "recording-drain-ack",
    request_id: drain.request_id,
    session_id: drain.session_id,
  });
  const stopped = await stopPromise;
  assert.equal(stopped.statusCode, 200);
});
