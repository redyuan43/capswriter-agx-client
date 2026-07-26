const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { once } = require("node:events");

const M5VoiceBridge = require("../src/helpers/m5VoiceBridge");

function request(port, headers = {}) {
  return requestJson(port, "/health", { headers });
}

function requestJson(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        } : {}),
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function requestBuffer(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: responseBody }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function startBridge(t, sendToRenderer = () => {}) {
  const commands = [];
  const bridge = new M5VoiceBridge({
    logger: { warn() {}, error() {}, info() {} },
    windowManager: {
      previousActiveWindow: "42",
      showFloatingBall() {},
    },
    clipboardManager: { setTargetWindow() {} },
    sendToRenderer,
  });
  bridge.port = 0;
  bridge.runCommand = async (command, args) => {
    commands.push({ command, args });
    return { success: true };
  };
  bridge.start();
  await once(bridge.server, "listening");
  t.after(() => bridge.stop());
  return { bridge, commands, port: bridge.server.address().port };
}

async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("health requires the configured token and returns bridge identity", async (t) => {
  const env = {
    M5_VOICE_BRIDGE_PORT: process.env.M5_VOICE_BRIDGE_PORT,
    M5_VOICE_BRIDGE_TOKEN: process.env.M5_VOICE_BRIDGE_TOKEN,
    M5_VOICE_BRIDGE_ID: process.env.M5_VOICE_BRIDGE_ID,
    M5_VOICE_BRIDGE_LABEL: process.env.M5_VOICE_BRIDGE_LABEL,
  };
  process.env.M5_VOICE_BRIDGE_PORT = "0";
  process.env.M5_VOICE_BRIDGE_TOKEN = "test-bridge-token";
  process.env.M5_VOICE_BRIDGE_ID = "desk-a";
  process.env.M5_VOICE_BRIDGE_LABEL = "Desk A";
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const bridge = new M5VoiceBridge({
    logger: { warn() {}, error() {}, info() {} },
    windowManager: {},
    clipboardManager: {},
    sendToRenderer() {},
  });
  bridge.start();
  await once(bridge.server, "listening");
  t.after(() => bridge.stop());
  const port = bridge.server.address().port;

  const unauthorized = await request(port);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await request(port, { "X-Vibe-Stick-Token": "test-bridge-token" });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(JSON.parse(authorized.body), {
    ok: true,
    bridge_id: "desk-a",
    bridge_label: "Desk A",
    bridge_name: "capswriter-m5-voice-bridge",
    bridge_version: "1.0.0",
    token_required: true,
  });
});

test("HTTP routing preserves method and unknown-path responses", async (t) => {
  const { port } = await startBridge(t);

  const unknownGet = await requestJson(port, "/unknown");
  assert.equal(unknownGet.statusCode, 405);
  assert.deepEqual(JSON.parse(unknownGet.body), {
    success: false,
    error: "method not allowed",
  });

  const unknownPost = await requestJson(port, "/unknown", {
    method: "POST",
    body: {},
  });
  assert.equal(unknownPost.statusCode, 404);
  assert.deepEqual(JSON.parse(unknownPost.body), {
    success: false,
    error: "not found",
  });
});

test("M5 audio chunks are idempotent by chunk_id", async (t) => {
  const { port } = await startBridge(t);
  const headers = {
    "X-Vibe-Stick-Device-Id": "wifi-stick-a",
    "X-Vibe-Stick-Firmware-Name": "vibestick",
  };
  const started = await requestJson(port, "/recording/start", {
    method: "POST",
    headers,
    body: { session_id: "idempotent-audio", intent: "dictation" },
  });
  assert.equal(JSON.parse(started.body).recording.capture_mode, "device_upload");

  const first = await requestBuffer(
    port,
    "/recording/audio?session_id=idempotent-audio&chunk_id=7",
    Buffer.from([1, 2, 3, 4]),
    headers
  );
  const duplicate = await requestBuffer(
    port,
    "/recording/audio?session_id=idempotent-audio&chunk_id=7",
    Buffer.from([1, 2, 3, 4]),
    headers
  );
  assert.deepEqual(JSON.parse(first.body).recording, {
    status: "recording",
    session_id: "idempotent-audio",
    bytes: 4,
    chunks: 1,
    chunk_id: "7",
    duplicate: false,
  });
  assert.equal(JSON.parse(duplicate.body).recording.duplicate, true);
  assert.equal(JSON.parse(duplicate.body).recording.bytes, 4);
});

test("device command poll returns commands for the requesting device", async (t) => {
  const { bridge, port } = await startBridge(t);
  bridge.commandBroker.enqueue("wifi-stick-b", {
    type: "recording_start",
    payload: { session_id: "remote-session" },
  });
  const response = await requestJson(
    port,
    "/device/commands/poll?cursor=0&timeout_ms=0",
    {
      headers: {
        "X-Vibe-Stick-Device-Id": "wifi-stick-b",
        "X-Vibe-Stick-Firmware-Name": "vibestick",
      },
    }
  );
  const payload = JSON.parse(response.body);
  assert.equal(payload.command.type, "recording_start");
  assert.equal(payload.command.payload.session_id, "remote-session");
});

test("M5 confirmation is accepted while transcription is still pending and runs after paste", async (t) => {
  let resolveStopDispatched;
  const stopDispatched = new Promise((resolve) => {
    resolveStopDispatched = resolve;
  });
  const { bridge, commands, port } = await startBridge(t, (eventName) => {
    if (eventName === "external-recording-stop") {
      resolveStopDispatched();
    }
  });
  const sessionId = "pending-confirmation";

  const start = await requestJson(port, "/recording/start", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation" },
  });
  assert.equal(start.statusCode, 200);

  const stopRequest = requestJson(port, "/recording/stop", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation", paste: true },
  });
  await stopDispatched;

  const acceptedAt = Date.now();
  const confirmation = await requestJson(port, "/event", {
    method: "POST",
    body: { event: "button_followup_enter", session_id: sessionId },
  });
  assert.ok(Date.now() - acceptedAt < 150);
  assert.ok(Buffer.byteLength(confirmation.body) < 256);
  const confirmationResponse = JSON.parse(confirmation.body);
  assert.equal("state" in confirmationResponse, false);
  assert.deepEqual(confirmationResponse.followup_enter, {
    status: "queued",
    session_id: sessionId,
  });
  assert.equal(commands.length, 0);

  await bridge.handleRendererResult({
    session_id: sessionId,
    success: true,
    status: "pasted",
    text: "ready",
  });
  const stop = await stopRequest;
  assert.equal(stop.statusCode, 200);

  await waitFor(() => assert.equal(commands.length, 2));
  assert.deepEqual(commands, [
    { command: "xdotool", args: ["windowactivate", "--sync", "42"] },
    { command: "xdotool", args: ["key", "--delay", "35", "Return"] },
  ]);
});

test("M5 confirmation never sends Enter after a failed paste", async (t) => {
  const { bridge, commands, port } = await startBridge(t);
  const sessionId = "failed-paste-confirmation";

  await requestJson(port, "/recording/start", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation" },
  });
  const confirmation = await requestJson(port, "/event", {
    method: "POST",
    body: { event: "button_followup_enter", session_id: sessionId },
  });
  assert.equal(JSON.parse(confirmation.body).followup_enter.status, "queued");

  await bridge.handleRendererResult({
    session_id: sessionId,
    success: false,
    status: "transcription_failed",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commands.length, 0);
});

test("M5 confirmation is rejected after the recording session has completed", async (t) => {
  const { bridge, commands, port } = await startBridge(t);
  const sessionId = "completed-confirmation";

  await requestJson(port, "/recording/start", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation" },
  });
  await bridge.handleRendererResult({
    session_id: sessionId,
    success: true,
    status: "pasted",
    text: "already done",
  });

  const confirmation = await requestJson(port, "/event", {
    method: "POST",
    body: { event: "button_followup_enter", session_id: sessionId },
  });
  const response = JSON.parse(confirmation.body);
  assert.equal(response.success, false);
  assert.deepEqual(response.followup_enter, {
    status: "session_completed",
    session_id: sessionId,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commands.length, 0);
});

test("M5 double click cancels the current dictation without sending Escape", async (t) => {
  const rendererEvents = [];
  let resolveStopDispatched;
  const stopDispatched = new Promise((resolve) => {
    resolveStopDispatched = resolve;
  });
  const { bridge, commands, port } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
    if (eventName === "external-recording-stop") {
      resolveStopDispatched();
    }
  });
  const sessionId = "cancel-current-dictation";

  await requestJson(port, "/recording/start", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation" },
  });
  const stopRequest = requestJson(port, "/recording/stop", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation", paste: true },
  });
  await stopDispatched;

  const cancellation = await requestJson(port, "/event", {
    method: "POST",
    body: { event: "button_followup_escape", session_id: sessionId },
  });
  const response = JSON.parse(cancellation.body);
  assert.equal(response.success, true);
  assert.deepEqual(response.followup_escape, {
    status: "cancelled",
    session_id: sessionId,
  });
  assert.ok(Buffer.byteLength(cancellation.body) < 256);
  assert.deepEqual(rendererEvents.at(-1), {
    eventName: "external-recording-cancel",
    payload: {
      session_id: sessionId,
      reason: "button_followup_escape",
    },
  });

  const stop = await stopRequest;
  const stopResponse = JSON.parse(stop.body);
  assert.equal(stop.statusCode, 200);
  assert.equal(stopResponse.recording.status, "cancelled");
  await bridge.handleRendererResult({
    session_id: sessionId,
    success: true,
    status: "pasted",
    text: "must be ignored after cancellation",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commands.length, 0);
});

test("M5 cancellation remains successful when it arrives before recording stop", async (t) => {
  const { commands, port } = await startBridge(t);
  const sessionId = "cancel-before-stop";

  await requestJson(port, "/recording/start", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation" },
  });
  const cancellation = await requestJson(port, "/event", {
    method: "POST",
    body: { event: "button_followup_escape", session_id: sessionId },
  });
  assert.equal(JSON.parse(cancellation.body).followup_escape.status, "cancelled");

  const stop = await requestJson(port, "/recording/stop", {
    method: "POST",
    body: { session_id: sessionId, intent: "dictation", paste: true },
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(JSON.parse(stop.body).recording.status, "cancelled");
  assert.equal(commands.length, 0);
});
