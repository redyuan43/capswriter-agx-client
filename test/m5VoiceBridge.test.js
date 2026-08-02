const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { once } = require("node:events");

const M5VoiceBridge = require("../src/helpers/m5VoiceBridge");
const {
  crc32Hex,
  diagnosticMatchesTarget,
  pcm16HasSignal,
  withoutNestedBridgeState,
} = M5VoiceBridge;

test("PCM signal detection rejects silence without hiding real samples", () => {
  assert.equal(pcm16HasSignal(Buffer.alloc(640)), false);
  assert.equal(pcm16HasSignal(Buffer.from([0, 0, 1, 0])), true);
});

test("diagnostic state strips nested bridge snapshots", () => {
  assert.deepEqual(withoutNestedBridgeState({
    stage: "ready",
    bridge: { state: { bluetooth: { last_diagnostic: {} } } },
    before: { bridge: { available: true }, audio_status: "failed" },
    after: [{ bridge: { available: true } }, { audio_status: "unknown" }],
  }), {
    stage: "ready",
    before: { audio_status: "failed" },
    after: [{}, { audio_status: "unknown" }],
  });
});

test("diagnostic state belongs only to its current Bluetooth target", () => {
  const diagnostic = {
    before: {
      bridge: { state: { bluetooth: { target_mac: "14:08:08:52:F9:62" } } },
    },
  };

  assert.equal(diagnosticMatchesTarget(diagnostic, "14:08:08:52:F9:62"), true);
  assert.equal(diagnosticMatchesTarget(diagnostic, "C8:85:41:68:39:0A"), false);
  assert.equal(diagnosticMatchesTarget({}, "14:08:08:52:F9:62"), false);
});

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
  bridge.pipeWireUnifiedSource.activate = () => ({
    source_node_name: "test-source",
    unified_source_name: "capswriter_input_bus.monitor",
  });
  bridge.pipeWireUnifiedSource.deactivate = () => ({
    previous_source_node_name: "test-source",
    unified_source_name: "capswriter_input_bus.monitor",
  });
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
  const health = JSON.parse(authorized.body);
  assert.equal(typeof health.bridge_instance_id, "string");
  assert.equal(health.recording_protocol_version, 2);
  assert.equal(health.max_concurrent_recordings, 4);
  assert.equal(health.recording_first_chunk_timeout_ms, 12000);
  assert.equal(health.recording_stall_timeout_ms, 10000);
  delete health.bridge_instance_id;
  delete health.recording_protocol_version;
  delete health.max_concurrent_recordings;
  delete health.recording_first_chunk_timeout_ms;
  delete health.recording_stall_timeout_ms;
  assert.deepEqual(health, {
    ok: true,
    bridge_id: "desk-a",
    bridge_label: "Desk A",
    bridge_name: "capswriter-m5-voice-bridge",
    bridge_version: "1.0.0",
    token_required: true,
  });

  const localRoutingUpdate = await requestJson(port, "/audio/routing", {
    method: "POST",
    body: { version: 1, routes: { keyboard: { source_id: "pipewire:test" } } },
  });
  assert.equal(localRoutingUpdate.statusCode, 200);

  assert.throws(
    () => bridge.requireToken(
      { headers: {}, socket: { remoteAddress: "::ffff:192.168.31.41" } },
      { allowLoopback: true }
    ),
    { message: "unauthorized", statusCode: 401 }
  );
});

test("bridge state requires verified MiniJoy audio instead of a residual PipeWire node", () => {
  const bridge = new M5VoiceBridge({
    logger: { warn() {}, error() {}, info() {} },
    windowManager: {},
    clipboardManager: {},
    sendToRenderer() {},
  });
  const source = {
      source_id: "pipewire:bluez_input.14_08_08_52_F9_62.0",
      name: "VibeStick MiniJoy F9:62",
      online: true,
      enumerated: true,
      transport_available: true,
      audio_health: { status: "unknown" },
      bluetooth: true,
      bluetooth_address: "14080852f962",
  };
  bridge.getAudioRoutingState = () => ({ sources: [source] });
  let state = bridge.buildState();
  assert.equal(state.wifi, true);
  assert.equal(state.ble, false);
  assert.equal(state.bluetooth.stage, "audio_unverified");
  assert.equal(state.bluetooth.pipewire_available, true);
  assert.equal(state.bluetooth.target_mac, "14:08:08:52:F9:62");
  assert.equal(state.bluetooth.source.source_id, "pipewire:bluez_input.14_08_08_52_F9_62.0");

  source.audio_health = { status: "healthy", last_success_at: "2026-07-28T10:00:00.000Z" };
  state = bridge.buildState();
  assert.equal(state.ble, true);
  assert.equal(state.bluetooth.stage, "ready");

  source.audio_health = { status: "failed", failure_reason: "first_audio_chunk_timeout" };
  state = bridge.buildState();
  assert.equal(state.ble, false);
  assert.equal(state.bluetooth.stage, "audio_capture_failed");
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

test("loopback dashboard can inspect and repair one Bluetooth MAC", async (t) => {
  const { bridge, port } = await startBridge(t);
  const device = {
    mac: "C8:85:41:68:39:0A",
    label: "MiniJoy 39:0A",
    name: "VibeStick MiniJoy",
    known: true,
    paired: false,
    bonded: false,
    trusted: false,
    connected: false,
  };
  bridge.bluetoothDevices.list = async () => [device];
  bridge.bluetoothDevices.repair = async (mac, options) => ({
    success: true,
    stage: "connected",
    device: { ...device, mac, connected: true },
    confirmCleanup: options.confirmCleanup,
    forceCleanup: options.forceCleanup,
  });

  const listed = await requestJson(port, "/bluetooth/devices");
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(JSON.parse(listed.body).devices, [device]);

  const rejectedOrigin = await requestJson(port, "/bluetooth/repair", {
    method: "POST",
    headers: { Origin: "http://evil.example" },
    body: { mac: device.mac },
  });
  assert.equal(rejectedOrigin.statusCode, 403);

  const repaired = await requestJson(port, "/bluetooth/repair", {
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${port}` },
    body: { mac: device.mac, confirm_cleanup: true, force_cleanup: true },
  });
  assert.equal(repaired.statusCode, 200);
  assert.equal(JSON.parse(repaired.body).device.mac, device.mac);
  assert.equal(JSON.parse(repaired.body).confirmCleanup, true);
  assert.equal(JSON.parse(repaired.body).forceCleanup, true);
});

test("dashboard inline script remains valid after server-side rendering", () => {
  const bridge = new M5VoiceBridge({
    logger: { warn() {}, error() {}, info() {} },
    windowManager: {},
    clipboardManager: {},
    sendToRenderer() {},
  });
  const html = bridge.buildDashboardHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(html, /音频输入路由/);
  assert.match(html, /实时 MiniJoy 蓝牙设备/);
  assert.match(html, /实时在线设备/);
  assert.match(html, /历史\/不可用路由/);
  assert.match(html, /已知但未连接的 MiniJoy/);
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
  const startPayload = JSON.parse(started.body);
  assert.equal(startPayload.recording.capture_mode, "device_upload");
  assert.equal("state" in startPayload, false);
  assert.ok(Buffer.byteLength(started.body) < 1024);

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

test("M5 starts renderer ASR only after the first accepted audio chunk", async (t) => {
  const rendererEvents = [];
  const { bridge, port } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  const headers = {
    "X-Vibe-Stick-Device-Id": "wifi-delayed-first-chunk",
    "X-Vibe-Stick-Firmware-Name": "vibestick",
  };
  await requestJson(port, "/recording/start", {
    method: "POST",
    headers,
    body: { session_id: "delayed-first-chunk", intent: "dictation" },
  });
  assert.deepEqual(rendererEvents, []);

  await requestBuffer(
    port,
    "/recording/audio?session_id=delayed-first-chunk&chunk_id=0",
    Buffer.from([1, 2, 3, 4]),
    headers
  );
  assert.deepEqual(rendererEvents.map((event) => event.eventName), [
    "external-recording-start",
    "external-recording-chunk",
  ]);
  bridge.abortAllSessions("test_cleanup");
});

test("M5 watchdog separates first-chunk delay from live-stream stalls", async (t) => {
  const { bridge } = await startBridge(t);
  const createdAt = 100000;
  const session = bridge.recordingSessions.create({
    id: "watchdog-policy",
    intent: "dictation",
  });
  session.createdAt = createdAt;

  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 4000), "");
  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 12000), "first_audio_chunk_timeout");

  session.lastUploadAttemptAt = createdAt + 11000;
  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 22000), "");
  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 23000), "first_audio_chunk_timeout");

  session.lastAudioAt = createdAt + 24000;
  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 33999), "");
  assert.equal(bridge.sessionTimeoutReason(session, createdAt + 34000), "audio_input_stalled");
});

test("protocol v2 rejects gaps and checksum mismatches before accepting audio", async (t) => {
  const { port } = await startBridge(t);
  const headers = {
    "X-Vibe-Stick-Device-Id": "wifi-stick-v2",
    "X-Vibe-Stick-Firmware-Name": "vibestick",
  };
  await requestJson(port, "/recording/start", {
    method: "POST",
    headers,
    body: { session_id: "verified-audio", intent: "dictation", protocol_version: 2 },
  });
  const audio = Buffer.from([1, 2, 3, 4]);
  const gap = await requestBuffer(
    port,
    "/recording/audio?session_id=verified-audio&chunk_id=1",
    audio,
    { ...headers, "X-Vibe-Stick-Chunk-CRC32": crc32Hex(audio) }
  );
  assert.equal(gap.statusCode, 409);

  const badCrc = await requestBuffer(
    port,
    "/recording/audio?session_id=verified-audio&chunk_id=0",
    audio,
    { ...headers, "X-Vibe-Stick-Chunk-CRC32": "00000000" }
  );
  assert.equal(badCrc.statusCode, 422);

  const accepted = await requestBuffer(
    port,
    "/recording/audio?session_id=verified-audio&chunk_id=0",
    audio,
    { ...headers, "X-Vibe-Stick-Chunk-CRC32": crc32Hex(audio) }
  );
  assert.deepEqual(JSON.parse(accepted.body).recording, {
    status: "recording",
    session_id: "verified-audio",
    bytes: 4,
    chunks: 1,
    chunk_id: "0",
    duplicate: false,
    expected_chunk_id: 1,
  });
});

test("simultaneous device recordings stay isolated and reach the renderer serially", async (t) => {
  const rendererEvents = [];
  const { bridge, port } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  const headersA = { "X-Vibe-Stick-Device-Id": "wifi-a", "X-Vibe-Stick-Firmware-Name": "vibestick" };
  const headersB = { "X-Vibe-Stick-Device-Id": "wifi-b", "X-Vibe-Stick-Firmware-Name": "vibestick" };
  await requestJson(port, "/recording/start", {
    method: "POST", headers: headersA, body: { session_id: "serial-a" },
  });
  await requestJson(port, "/recording/start", {
    method: "POST", headers: headersB, body: { session_id: "serial-b" },
  });
  await requestBuffer(port, "/recording/audio?session_id=serial-a&chunk_id=0", Buffer.from([1, 1]), headersA);
  await requestBuffer(port, "/recording/audio?session_id=serial-b&chunk_id=0", Buffer.from([2, 2]), headersB);

  assert.deepEqual(
    rendererEvents.filter((event) => event.eventName === "external-recording-start").map((event) => event.payload.session_id),
    ["serial-a"]
  );
  const stopB = requestJson(port, "/recording/stop", {
    method: "POST", headers: headersB, body: { session_id: "serial-b" },
  });
  const stopA = requestJson(port, "/recording/stop", {
    method: "POST", headers: headersA, body: { session_id: "serial-a" },
  });
  await waitFor(() => assert.ok(rendererEvents.some((event) =>
    event.eventName === "external-recording-stop" && event.payload.session_id === "serial-a"
  )));
  await bridge.handleRendererResult({ session_id: "serial-a", success: true, status: "pasted", text: "a" });
  await waitFor(() => assert.ok(rendererEvents.some((event) =>
    event.eventName === "external-recording-stop" && event.payload.session_id === "serial-b"
  )));
  const replayedB = rendererEvents.find((event) =>
    event.eventName === "external-recording-chunk" && event.payload.session_id === "serial-b"
  );
  assert.equal(Buffer.from(replayedB.payload.chunk).toString("hex"), "0202");
  await bridge.handleRendererResult({ session_id: "serial-b", success: true, status: "pasted", text: "b" });
  assert.equal((await stopA).statusCode, 200);
  assert.equal((await stopB).statusCode, 200);
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

test("audio routes apply input and output independently", async (t) => {
  const { bridge } = await startBridge(t);
  const calls = [];
  bridge.pipeWireUnifiedSource.activate = (sourceNodeName, sinkNodeName) => {
    calls.push({ type: "route", sourceNodeName, sinkNodeName });
    return {
      default_source_name: sourceNodeName,
      default_sink_name: sinkNodeName,
    };
  };
  bridge.pipeWireUnifiedSource.setDefaultSink = (sinkNodeName) => {
    calls.push({ type: "output", sinkNodeName });
    return { default_sink_name: sinkNodeName };
  };
  const sink = {
    node_name: "alsa_output.usb-mi-speaker",
    online: true,
  };

  const localResult = bridge.applyAudioRoute({
    available: true,
    output_available: true,
    source: {
      kind: "pipewire",
      node_name: "bluez_input.C8_85_41_68_39_0A.0",
    },
    sink,
  });
  const remoteResult = bridge.applyAudioRoute({
    available: true,
    output_available: true,
    source: {
      kind: "wifi",
      source_id: "wifi:stick-a",
    },
    sink,
  }, { activateInput: false });

  assert.deepEqual(calls, [
    {
      type: "route",
      sourceNodeName: "bluez_input.C8_85_41_68_39_0A.0",
      sinkNodeName: "alsa_output.usb-mi-speaker",
    },
    {
      type: "output",
      sinkNodeName: "alsa_output.usb-mi-speaker",
    },
  ]);
  assert.equal(localResult.input_applied, true);
  assert.equal(localResult.output_applied, true);
  assert.equal(remoteResult.input_applied, false);
  assert.equal(remoteResult.output_applied, true);
});

test("MiniJoy host trigger captures native HFP PCM without browser recording", async (t) => {
  const rendererEvents = [];
  const { bridge } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  bridge.audioRouting.activateTrigger = () => ({
    trigger_id: "minijoy_bt",
    source_id: "pipewire:bluez_input.C8_85_41_68_39_0A",
    source: {
      node_name: "bluez_input.C8_85_41_68_39_0A.0",
      online: true,
    },
    available: true,
  });
  bridge.audioRouting.clearActiveRoute = () => {};
  bridge.pipeWireUnifiedSource.activate = () => {};
  let restoredDefaultSource = false;
  bridge.restoreUnifiedDefaultSource = () => {
    restoredDefaultSource = true;
  };
  let emitChunk = null;
  let stoppedSessionId = "";
  let captureNodeName = "";
  bridge.pipeWireCapture.start = (_sessionId, _sourceId, onChunk, nodeName) => {
    emitChunk = onChunk;
    captureNodeName = nodeName;
  };
  bridge.pipeWireCapture.stop = (sessionId) => {
    stoppedSessionId = sessionId;
    return true;
  };

  const started = await bridge.handleHostTriggerDown("minijoy_bt", "42");
  emitChunk(Buffer.alloc(640));
  assert.equal(
    bridge.audioRouting.captureHealthFor("pipewire:bluez_input.C8_85_41_68_39_0A").status,
    "unknown"
  );
  assert.deepEqual(rendererEvents.map((event) => event.eventName), [
    "external-recording-armed",
  ]);
  emitChunk(Buffer.from([1, 2, 3, 4]));
  assert.equal(
    bridge.audioRouting.captureHealthFor("pipewire:bluez_input.C8_85_41_68_39_0A").status,
    "healthy"
  );
  const stopped = await bridge.handleHostTriggerUp("minijoy_bt");

  assert.equal(started.handled, true);
  assert.equal(captureNodeName, "capswriter_input_bus.monitor");
  assert.equal(stopped.session_id, started.session_id);
  assert.equal(stoppedSessionId, started.session_id);
  assert.equal(restoredDefaultSource, true);
  assert.deepEqual(rendererEvents.map((event) => event.eventName), [
    "external-recording-armed",
    "external-recording-start",
    "external-recording-chunk",
    "external-recording-stop",
  ]);
  assert.equal(rendererEvents[3].payload.bytes, 4);
  assert.equal(rendererEvents[3].payload.chunks, 1);
  assert.equal(bridge.sessions.get(started.session_id).silentBytes, 640);
});

test("concurrent host triggers arm only the renderer-owned session", async (t) => {
  const rendererEvents = [];
  const { bridge } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  const captures = new Map();
  bridge.audioRouting.activateTrigger = (triggerId) => {
    const address = triggerId.split(":")[1];
    return {
      trigger_id: triggerId,
      source_id: `pipewire:bluez_input.${address}`,
      source: {
        node_name: `bluez_input.${address}.0`,
        online: true,
      },
      available: true,
    };
  };
  bridge.audioRouting.clearActiveRoute = () => {};
  bridge.pipeWireUnifiedSource.activate = () => {};
  bridge.restoreUnifiedDefaultSource = () => {};
  bridge.pipeWireCapture.start = (sessionId, _sourceId, onChunk) => {
    captures.set(sessionId, onChunk);
    return { pid: 1234 };
  };
  bridge.pipeWireCapture.stop = () => true;

  const first = await bridge.handleHostTriggerDown("minijoy_bt:aaaaaaaaaaaa", "42");
  const second = await bridge.handleHostTriggerDown("minijoy_bt:bbbbbbbbbbbb", "43");

  assert.deepEqual(
    rendererEvents
      .filter((event) => event.eventName === "external-recording-armed")
      .map((event) => event.payload.session_id),
    [first.session_id]
  );

  captures.get(second.session_id)(Buffer.from([2, 2, 2, 2]));
  assert.equal(
    rendererEvents.some((event) =>
      event.eventName === "external-recording-start" &&
      event.payload.session_id === second.session_id
    ),
    false
  );

  captures.get(first.session_id)(Buffer.from([1, 1, 1, 1]));
  assert.deepEqual(
    rendererEvents
      .filter((event) => event.eventName === "external-recording-start")
      .map((event) => event.payload.session_id),
    [first.session_id]
  );

  await bridge.handleHostTriggerUp("minijoy_bt:bbbbbbbbbbbb");
  await bridge.handleHostTriggerUp("minijoy_bt:aaaaaaaaaaaa");
  await bridge.handleRendererResult({
    session_id: first.session_id,
    success: true,
    status: "pasted",
    text: "first",
  });
  await waitFor(() => assert.ok(rendererEvents.some((event) =>
    event.eventName === "external-recording-start" &&
    event.payload.session_id === second.session_id
  )));
  await bridge.handleRendererResult({
    session_id: second.session_id,
    success: true,
    status: "pasted",
    text: "second",
  });
});

test("MiniJoy host capture with no PCM records an audio failure but remains retryable", async (t) => {
  const rendererEvents = [];
  const { bridge, commands } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  let recoveryTimeoutMs = 0;
  const runCommand = bridge.runCommand;
  bridge.runCommand = (command, args, timeoutMs) => {
    recoveryTimeoutMs = timeoutMs;
    return runCommand(command, args);
  };
  const sourceId = "pipewire:bluez_input.C8_85_41_68_39_0A";
  bridge.audioRouting.activateTrigger = () => ({
    trigger_id: "minijoy_bt",
    source_id: sourceId,
    source: { node_name: "bluez_input.C8_85_41_68_39_0A.0", online: true },
    available: true,
  });
  bridge.audioRouting.clearActiveRoute = () => {};
  bridge.pipeWireUnifiedSource.activate = () => {};
  bridge.pipeWireCapture.start = () => {};
  bridge.pipeWireCapture.stop = () => true;
  bridge.restoreUnifiedDefaultSource = () => {};
  let finishCaptureCleanup;
  bridge.waitForCaptureExit = () => new Promise((resolve) => {
    finishCaptureCleanup = resolve;
  });

  const started = await bridge.handleHostTriggerDown("minijoy_bt", "42");
  const stopped = await bridge.handleHostTriggerUp("minijoy_bt");

  assert.equal(started.handled, true);
  assert.equal(stopped.error, "recording contains no audio");
  assert.deepEqual(rendererEvents.map((event) => event.eventName), [
    "external-recording-armed",
    "external-recording-error",
  ]);
  assert.equal(rendererEvents[1].payload.error, "未收到麦克风音频");
  assert.equal(bridge.audioRouting.captureHealthFor(sourceId).status, "failed");
  assert.equal(bridge.audioRouting.captureHealthFor(sourceId).failure_reason, "audio_input_empty");
  assert.equal(commands.length, 0);
  finishCaptureCleanup(true);
  await waitFor(() => assert.equal(commands.length, 1));
  assert.equal(commands[0].args.includes("repair"), true);
  assert.equal(commands[0].args.includes("--audio-only"), true);
  assert.equal(commands[0].args.includes("--reconnect-only"), true);
  assert.equal(commands[0].args.includes("--recover-bluez"), false);
  assert.equal(recoveryTimeoutMs, 180000);
  assert.deepEqual(commands[0].args.slice(-2), ["--mac", "C8:85:41:68:39:0A"]);
  assert.equal(
    bridge.scheduleBluetoothAudioRecovery({ sourceId }, "audio_input_empty"),
    false
  );
  assert.equal(
    bridge.scheduleBluetoothAudioRecovery(
      { sourceId: "pipewire:alsa_input.usb-microphone" },
      "audio_input_empty"
    ),
    false
  );
});

test("keyboard host trigger captures native USB PCM without browser recording", async (t) => {
  const rendererEvents = [];
  const { bridge } = await startBridge(t, (eventName, payload) => {
    rendererEvents.push({ eventName, payload });
  });
  bridge.audioRouting.activateTrigger = () => ({
    trigger_id: "keyboard",
    source_id: "pipewire:alsa_input.usb-mi-speakphone",
    source: {
      node_name: "alsa_input.usb-mi-speakphone.4",
      online: true,
    },
    available: true,
  });
  bridge.audioRouting.clearActiveRoute = () => {};
  bridge.pipeWireUnifiedSource.activate = () => {};
  let restoredDefaultSource = false;
  bridge.restoreUnifiedDefaultSource = () => {
    restoredDefaultSource = true;
  };
  let emitChunk = null;
  let captureNodeName = "";
  bridge.pipeWireCapture.start = (_sessionId, _sourceId, onChunk, nodeName) => {
    emitChunk = onChunk;
    captureNodeName = nodeName;
  };
  bridge.pipeWireCapture.stop = () => true;

  const started = await bridge.handleHostTriggerDown("keyboard", "42");
  emitChunk(Buffer.from([5, 6, 7, 8]));
  await bridge.handleHostTriggerUp("keyboard");

  assert.equal(started.handled, true);
  assert.equal(captureNodeName, "capswriter_input_bus.monitor");
  assert.equal(restoredDefaultSource, true);
  assert.deepEqual(rendererEvents.map((event) => event.eventName), [
    "external-recording-armed",
    "external-recording-start",
    "external-recording-chunk",
    "external-recording-stop",
  ]);
  assert.equal(rendererEvents[3].payload.bytes, 4);
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
  await requestBuffer(
    port,
    `/recording/audio?session_id=${sessionId}&chunk_id=0`,
    Buffer.from([1, 2, 3, 4])
  );

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
  await requestBuffer(
    port,
    `/recording/audio?session_id=${sessionId}&chunk_id=0`,
    Buffer.from([1, 2, 3, 4])
  );
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
