const assert = require("node:assert/strict");
const test = require("node:test");

const BluetoothDeviceManager = require("../src/helpers/bluetoothDeviceManager");
const {
  normalizeMac,
  parseBluetoothInfo,
  parseDeviceList,
  bluetoothCommandSucceeded,
  pairingArgs,
  pipeWireCardName,
  MINIJOY_HFP_PROFILE,
  MINIJOY_HFP_UUID,
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
    if (command === "sh" && args[1]?.includes(` pair ${MAC}`)) {
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

test("Bluetooth command output can report a pairing failure despite a zero exit status", () => {
  assert.equal(bluetoothCommandSucceeded({ success: true, stdout: "Failed to pair: org.bluez.Error.Failed" }), false);
  assert.equal(bluetoothCommandSucceeded({ success: true, stdout: "Pairing successful" }), true);
  assert.deepEqual(pairingArgs(MAC), [
    "--agent",
    "NoInputNoOutput",
    "--timeout",
    "30",
    "pair",
    MAC,
  ]);
  assert.equal(pipeWireCardName(MAC), "bluez_card.C8_85_41_68_39_0A");
  assert.equal(MINIJOY_HFP_PROFILE, "headset-head-unit-msbc");
});

test("Bluetooth audio reset cycles only the PipeWire profile before selecting mSBC", async () => {
  const commands = [];
  const waits = [];
  const manager = new BluetoothDeviceManager({
    wait: async (milliseconds) => waits.push(milliseconds),
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "bluetoothctl" && args[0] === "info") {
        return {
          success: true,
          stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: yes\n  Bonded: yes\n  Trusted: yes\n  Connected: yes`,
        };
      }
      return { success: true, stdout: "" };
    },
  });

  const result = await manager.resetAudioProfile(MAC, 1);

  assert.equal(result.success, true);
  assert.equal(result.recovery, "pipewire_profile_reset");
  assert.deepEqual(commands[0], [
    "bluetoothctl",
    "info",
    MAC,
  ]);
  assert.deepEqual(commands[1], [
    "pactl",
    "set-card-profile",
    "bluez_card.C8_85_41_68_39_0A",
    "off",
  ]);
  assert.deepEqual(commands[3], [
    "pactl",
    "set-card-profile",
    "bluez_card.C8_85_41_68_39_0A",
    "headset-head-unit-msbc",
  ]);
  assert.equal(commands.some((command) => command[0] === "busctl"), false);
  assert.equal(commands.some((command) => command.includes("disconnect")), false);
  assert.deepEqual(waits, [200]);
});

test("Bluetooth audio reset falls back to one device transport reconnect", async () => {
  const commands = [];
  let transportReconnected = false;
  const manager = new BluetoothDeviceManager({
    wait: async () => {},
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "bluetoothctl" && args[0] === "info") {
        return {
          success: true,
          stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: yes\n  Bonded: yes\n  Trusted: yes\n  Connected: yes`,
        };
      }
      if (command === "bluetoothctl" && args.includes("connect")) {
        transportReconnected = true;
        return { success: true, stdout: "Connection successful" };
      }
      if (command === "pactl") {
        return transportReconnected
          ? { success: true, stdout: "" }
          : { success: false, stderr: "Failure: No such entity" };
      }
      return { success: true, stdout: "" };
    },
  });

  const result = await manager.resetAudioProfile(MAC, 2);

  assert.equal(result.success, true);
  assert.equal(result.recovery, "device_transport_reconnect");
  assert.deepEqual(commands.find((command) => command[1] === "disconnect"), [
    "bluetoothctl",
    "disconnect",
    MAC,
  ]);
  assert.deepEqual(commands.find((command) => command.includes("connect")), [
    "bluetoothctl",
    "--timeout",
    "15",
    "connect",
    MAC,
  ]);
});

test("Bluetooth audio activation reconnects an idle paired MiniJoy before selecting mSBC", async () => {
  const commands = [];
  let connected = false;
  const manager = new BluetoothDeviceManager({
    wait: async () => {},
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "bluetoothctl" && args[0] === "info") {
        return {
          success: true,
          stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: yes\n  Bonded: yes\n  Trusted: yes\n  Connected: ${connected ? "yes" : "no"}`,
        };
      }
      if (command === "bluetoothctl" && args.includes("connect")) {
        connected = true;
        return { success: true, stdout: "Connection successful" };
      }
      return { success: true, stdout: "" };
    },
  });

  const result = await manager.activateAudioProfile(MAC, 2);

  assert.equal(result.success, true);
  assert.deepEqual(commands.find((command) => command.includes("connect")), [
    "bluetoothctl",
    "--timeout",
    "12",
    "connect",
    MAC,
  ]);
  assert.deepEqual(commands.find((command) => command[0] === "pactl"), [
    "pactl",
    "set-card-profile",
    "bluez_card.C8_85_41_68_39_0A",
    "headset-head-unit-msbc",
  ]);
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
    if (command === "sh" && args[1]?.includes(` pair ${MAC}`)) {
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
  assert.equal(
    commands.filter((command) => command[0] === "sh" && command[2]?.includes("scan on")).length,
    2
  );
  assert.equal(commands.some((command) => command.includes("14:08:08:52:F9:62")), false);
  assert.deepEqual(commands.find((command) => command[0] === "pactl"), [
    "pactl",
    "set-card-profile",
    "bluez_card.C8_85_41_68_39_0A",
    "headset-head-unit-msbc",
  ]);
});

test("forced Bluetooth cleanup re-pairs an already connected MiniJoy by MAC", async () => {
  const commands = [];
  let paired = true;
  const runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "info") {
      return {
        success: true,
        stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: ${paired ? "yes" : "no"}\n  Bonded: ${paired ? "yes" : "no"}\n  Trusted: ${paired ? "yes" : "no"}\n  Connected: ${paired ? "yes" : "no"}`,
      };
    }
    if (args[0] === "remove") paired = false;
    if (command === "sh" && args[1]?.includes(` pair ${MAC}`)) paired = true;
    return { success: true, stdout: "ok" };
  };
  const manager = new BluetoothDeviceManager({ runCommand });
  const result = await manager.repair(MAC, {
    confirmCleanup: true,
    forceCleanup: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(commands.find((command) => command[1] === "remove"), ["bluetoothctl", "remove", MAC]);
  assert.equal(
    commands.some((command) => command[0] === "sh" && command[2]?.includes(` pair ${MAC}`)),
    true
  );
});

test("Bluetooth repair rejects a false-success pairing command when BlueZ remains unpaired", async () => {
  const runCommand = async (command, args) => {
    if (args[0] === "info") {
      return {
        success: true,
        stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: no\n  Bonded: no\n  Trusted: no\n  Connected: no`,
      };
    }
    if (command === "sh" && args[1]?.includes(` pair ${MAC}`)) {
      return { success: true, stdout: "Failed to pair: org.bluez.Error.Failed" };
    }
    return { success: true, stdout: "ok" };
  };
  const manager = new BluetoothDeviceManager({ runCommand });
  const result = await manager.repair(MAC);

  assert.equal(result.success, false);
  assert.equal(result.stage, "pair_failed");
});

test("Bluetooth repair accepts a partial BlueZ connect once the mSBC audio profile works", async () => {
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "info") {
      return {
        success: true,
        stdout: `Device ${MAC}\n  Name: VibeStick MiniJoy\n  Paired: yes\n  Bonded: yes\n  Trusted: yes\n  Connected: yes`,
      };
    }
    if (command === "bluetoothctl" && args[0] === "connect") {
      return {
        success: false,
        stdout: "Failed to connect: org.bluez.Error.Failed br-connection-create-socket",
      };
    }
    return { success: true, stdout: "ok" };
  };
  const manager = new BluetoothDeviceManager({
    runCommand,
    wait: async () => {},
  });

  const result = await manager.repair(MAC);

  assert.equal(result.success, true);
  assert.equal(result.stage, "connected");
  assert.equal(result.audio_profile.profile, "headset-head-unit-msbc");
  assert.equal(commands.some((command) => command[0] === "pactl"), true);
});
