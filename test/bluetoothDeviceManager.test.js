const assert = require("node:assert/strict");
const test = require("node:test");

const BluetoothDeviceManager = require("../src/helpers/bluetoothDeviceManager");
const {
  normalizeMac,
  parseBluetoothInfo,
  parseDeviceList,
} = BluetoothDeviceManager;

const MAC = "C8:85:41:68:39:0A";

test("Bluetooth MiniJoy identity is normalized and displayed by MAC suffix", () => {
  assert.equal(normalizeMac("c8854168390a"), MAC);
  assert.equal(normalizeMac("not-a-mac"), "");
  assert.deepEqual(parseDeviceList(`Device ${MAC} VibeStick MiniJoy\nDevice AA:BB:CC:DD:EE:FF Phone`), [
    { mac: MAC, name: "VibeStick MiniJoy" },
  ]);
  const state = parseBluetoothInfo(`Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: yes\n  Bonded: yes\n  Trusted: yes\n  Connected: yes`, MAC);
  assert.equal(state.label, "MiniJoy 39:0A");
  assert.equal(state.connected, true);
});

test("Bluetooth repair asks before removing one stale MAC", async () => {
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "info") {
      return { success: true, stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: no\n  Bonded: no\n  Trusted: no\n  Connected: no` };
    }
    if (args[0] === "pair") {
      return { success: false, stdout: "Failed to pair: org.bluez.Error.AlreadyExists" };
    }
    return { success: true, stdout: "" };
  };
  const manager = new BluetoothDeviceManager({ runCommand });
  const result = await manager.repair(MAC);

  assert.equal(result.statusCode, 409);
  assert.equal(result.requires_cleanup, true);
  assert.equal(commands.some((command) => command.includes("remove")), false);
});

test("confirmed Bluetooth cleanup removes only the requested MAC before pairing", async () => {
  const commands = [];
  let paired = false;
  let pairAttempts = 0;
  const runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "info") {
      return {
        success: true,
        stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: ${paired ? "yes" : "no"}\n  Bonded: ${paired ? "yes" : "no"}\n  Trusted: ${paired ? "yes" : "no"}\n  Connected: ${paired ? "yes" : "no"}`,
      };
    }
    if (args[0] === "pair") {
      pairAttempts += 1;
      if (pairAttempts === 1) return { success: false, stdout: "org.bluez.Error.AlreadyExists" };
      paired = true;
    }
    return { success: true, stdout: "ok" };
  };
  const manager = new BluetoothDeviceManager({ runCommand });
  const result = await manager.repair(MAC, { confirmCleanup: true });

  assert.equal(result.success, true);
  assert.deepEqual(commands.find((command) => command[1] === "remove"), ["bluetoothctl", "remove", MAC]);
  assert.equal(commands.some((command) => command.includes("14:08:08:52:F9:62")), false);
});
