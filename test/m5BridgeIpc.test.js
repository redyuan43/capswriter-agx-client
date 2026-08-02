const assert = require("node:assert/strict");
const test = require("node:test");

const { registerM5BridgeHandlers } = require("../src/platform/electron/ipc/m5BridgeHandlers");

test("M5 Bluetooth repair IPC delegates one MAC with confirmed cleanup", async () => {
  const handlers = new Map();
  const calls = [];
  registerM5BridgeHandlers({
    m5VoiceBridge: {
      repairBluetoothDevice(mac, options) {
        calls.push({ mac, options });
        return { success: true, mac };
      },
    },
  }, {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  const result = await handlers.get("repair-m5-bluetooth-device")(
    {},
    "14:08:08:52:F9:62"
  );

  assert.deepEqual(result, { success: true, mac: "14:08:08:52:F9:62" });
  assert.deepEqual(calls, [{
    mac: "14:08:08:52:F9:62",
    options: {
      confirmCleanup: true,
      forceCleanup: true,
    },
  }]);
});
