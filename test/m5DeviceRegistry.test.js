const assert = require("node:assert/strict");
const test = require("node:test");

const M5DeviceRegistry = require("../src/helpers/m5DeviceRegistry");

function request(headers, remoteAddress = "::ffff:192.168.31.91") {
  return {
    headers,
    socket: { remoteAddress },
  };
}

test("device registry preserves identity while refreshing device metadata", () => {
  let now = 1000;
  const registry = new M5DeviceRegistry({ now: () => now });
  const headers = {
    "x-vibe-stick-device-id": "f0:16:1d:03:3b:cc",
    "x-vibe-stick-firmware-name": "vibestick",
    "x-vibe-stick-firmware-version": "0.1.35",
    "x-vibe-stick-board": "stickc_plus",
    "x-vibe-stick-wifi-ssid": "330",
    "x-vibe-stick-wifi-rssi": "-61",
  };

  registry.remember(request(headers), "/health");
  now = 2000;
  registry.remember(request({
    ...headers,
    "x-vibe-stick-firmware-version": "0.1.36",
  }), "/state");

  assert.equal(registry.devices.size, 1);
  assert.deepEqual(registry.list().map((device) => ({
    device_id: device.device_id,
    client_ip: device.client_ip,
    path: device.path,
    last_seen: device.last_seen,
    firmware_version: device.firmware_version,
    board: device.board,
    wifi_ssid: device.wifi_ssid,
    wifi_rssi: device.wifi_rssi,
  })), [{
    device_id: "f0:16:1d:03:3b:cc",
    client_ip: "192.168.31.91",
    path: "/state",
    last_seen: 2000,
    firmware_version: "0.1.36",
    board: "stickc_plus",
    wifi_ssid: "330",
    wifi_rssi: -61,
  }]);
});

test("device registry prunes stale devices and ignores ordinary clients", () => {
  let now = 1000;
  const registry = new M5DeviceRegistry({ retentionMs: 500, now: () => now });

  assert.equal(registry.remember(request({}), "/health"), null);
  registry.remember(request({
    "x-vibe-stick-firmware-name": "vibestick",
  }), "/health");
  assert.equal(registry.list().length, 1);

  now = 1501;
  assert.deepEqual(registry.list(), []);
});
