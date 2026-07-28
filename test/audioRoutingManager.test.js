const assert = require("node:assert/strict");
const test = require("node:test");

const AudioRoutingManager = require("../src/helpers/audioRoutingManager");

function createDatabase(initial = null) {
  let value = initial;
  return {
    getSetting(_key, fallback) {
      return value ?? fallback;
    },
    setSetting(_key, next) {
      value = next;
    },
    value() {
      return value;
    },
  };
}

const pactlSources = [
  {
    name: "alsa_input.usb-rockchip_MI_Speakphone_0123456789ABCDEF-00.mono-fallback.4",
    description: "MI Speakphone Mono",
    state: "SUSPENDED",
    properties: { "node.name": "alsa_input.usb-rockchip_MI_Speakphone_0123456789ABCDEF-00.mono-fallback.4" },
  },
  {
    name: "bluez_input.C8_85_41_68_39_0A.0",
    description: "VibeStick MiniJoy",
    state: "RUNNING",
    properties: {
      "node.name": "bluez_input.C8_85_41_68_39_0A.0",
      "api.bluez5.address": "C8:85:41:68:39:0A",
    },
  },
  {
    name: "bluez_input.F0_16_1D_03_3B_CE.0",
    description: "VibeStick MiniJoy",
    state: "SUSPENDED",
    properties: {
      "node.name": "bluez_input.F0_16_1D_03_3B_CE.0",
      "api.bluez5.address": "F0:16:1D:03:3B:CE",
    },
  },
  {
    name: "capswriter_input_bus.monitor",
    description: "Monitor",
    state: "IDLE",
    properties: {},
  },
];

function createManager(databaseManager = createDatabase()) {
  return new AudioRoutingManager({
    databaseManager,
    runCommand: () => JSON.stringify(pactlSources),
    wifiDeviceProvider: () => [{
      device_id: "14:c1:9f:d5:65:c4",
      board: "sticks3",
      device_ip: "192.168.100.190",
      firmware_version: "0.1.60",
    }],
  });
}

test("audio routing assigns defaults by trigger origin", () => {
  const manager = createManager();

  assert.match(manager.resolveRoute("keyboard").source_id, /MI_Speakphone/);
  assert.match(manager.resolveRoute("minijoy_bt").source_id, /bluez_input/);
  assert.equal(
    manager.resolveRoute("minijoy_bt:f0161d033bce").source_id,
    "pipewire:bluez_input.F0_16_1D_03_3B_CE"
  );
  assert.equal(
    manager.resolveRoute("wifi:14:c1:9f:d5:65:c4").source_id,
    "wifi:14:c1:9f:d5:65:c4"
  );
});

test("audio routing persists explicit cross-device mappings", () => {
  const database = createDatabase();
  const manager = createManager(database);
  const saved = manager.saveRoutes({
    routes: {
      keyboard: { source_id: "wifi:14:c1:9f:d5:65:c4" },
      "wifi:14:c1:9f:d5:65:c4": {
        source_id: "pipewire:bluez_input.C8_85_41_68_39_0A",
      },
    },
  });

  assert.deepEqual(database.value(), saved);
  assert.equal(manager.resolveRoute("keyboard").source.kind, "wifi");
  assert.equal(
    manager.resolveRoute("wifi:14:c1:9f:d5:65:c4").source.kind,
    "pipewire"
  );
});

test("audio routing strips volatile PipeWire node suffixes", () => {
  const manager = createManager();
  const sources = manager.listPipeWireSources();
  assert.equal(
    sources[0].source_id,
    "pipewire:alsa_input.usb-rockchip_MI_Speakphone_0123456789ABCDEF-00.mono-fallback"
  );
  assert.equal(sources.some((source) => source.node_name.endsWith(".monitor")), false);
});

test("audio routing advertises the actual unified PipeWire monitor", () => {
  const manager = createManager();
  assert.equal(
    manager.getState().unified_source.node_name,
    "capswriter_input_bus.monitor"
  );
});

test("audio routing exposes same-name MiniJoy devices as independent triggers", () => {
  const state = createManager().getState();
  assert.equal(state.version, 2);
  assert.equal(state.routes["minijoy_bt:c8854168390a"].trigger_name, "MiniJoy 39:0A");
  assert.equal(state.routes["minijoy_bt:f0161d033bce"].trigger_name, "MiniJoy 3B:CE");
  assert.equal(state.routes["minijoy_bt:c8854168390a"].source_id, "pipewire:bluez_input.C8_85_41_68_39_0A");
  assert.equal(state.routes["minijoy_bt:f0161d033bce"].source_id, "pipewire:bluez_input.F0_16_1D_03_3B_CE");
});

test("audio routing migrates the legacy shared MiniJoy route to its Bluetooth identity", () => {
  const database = createDatabase({
    version: 1,
    routes: {
      minijoy_bt: { source_id: "pipewire:bluez_input.F0_16_1D_03_3B_CE" },
    },
  });
  const state = createManager(database).getState();
  assert.equal("minijoy_bt" in state.routes, false);
  assert.equal(
    state.routes["minijoy_bt:f0161d033bce"].source_id,
    "pipewire:bluez_input.F0_16_1D_03_3B_CE"
  );
  assert.equal(database.value().version, 2);
});

test("audio routing distinguishes enumeration from verified capture health", () => {
  let now = Date.parse("2026-07-28T10:00:00.000Z");
  const manager = new AudioRoutingManager({
    runCommand: () => JSON.stringify(pactlSources),
    now: () => now,
  });
  const sourceId = "pipewire:bluez_input.C8_85_41_68_39_0A";

  let source = manager.listPipeWireSources().find((item) => item.source_id === sourceId);
  assert.equal(source.enumerated, true);
  assert.equal(source.transport_available, true);
  assert.equal(source.audio_health.status, "unknown");

  manager.recordCaptureFailure(sourceId, "first_audio_chunk_timeout", { sessionId: "failed" });
  source = manager.listPipeWireSources().find((item) => item.source_id === sourceId);
  assert.equal(source.audio_health.status, "failed");
  assert.equal(source.audio_health.failure_reason, "first_audio_chunk_timeout");
  assert.equal(manager.resolveRoute("minijoy_bt:c8854168390a").available, true);

  now += 1000;
  manager.recordCaptureSuccess(sourceId, { bytes: 640 });
  source = manager.listPipeWireSources().find((item) => item.source_id === sourceId);
  assert.equal(source.audio_health.status, "healthy");
  assert.equal(source.audio_health.last_success_bytes, 640);
  assert.equal(source.audio_health.failure_reason, "");
  assert.equal(source.audio_health.last_success_at, "2026-07-28T10:00:01.000Z");
});
