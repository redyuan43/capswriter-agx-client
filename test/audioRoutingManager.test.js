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
    properties: { "node.name": "bluez_input.C8_85_41_68_39_0A.0" },
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
