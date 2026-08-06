const MAC_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const MINIJOY_HFP_PROFILE = "headset-head-unit-msbc";
const MINIJOY_HFP_UUID = "0000111e-0000-1000-8000-00805f9b34fb";

function normalizeMac(value) {
  const compact = String(value || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (compact.length !== 12) return "";
  const mac = compact.match(/.{2}/g).join(":");
  return MAC_PATTERN.test(mac) ? mac : "";
}

function parseBluetoothInfo(raw, mac = "") {
  const text = String(raw || "");
  const field = (name) => text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() || "";
  const bool = (name) => field(name).toLowerCase() === "yes";
  const normalizedMac = normalizeMac(mac || text.match(/^Device\s+([0-9A-F:]{17})/mi)?.[1]);
  const name = field("Name") || field("Alias");
  return {
    mac: normalizedMac,
    label: normalizedMac ? `MiniJoy ${normalizedMac.slice(-5)}` : "MiniJoy",
    name,
    known: Boolean(normalizedMac && text.trim()),
    paired: bool("Paired"),
    bonded: bool("Bonded"),
    trusted: bool("Trusted"),
    connected: bool("Connected"),
    pairing_ready: Boolean(normalizedMac && text.trim() && !bool("Paired")),
  };
}

function parseDeviceList(raw) {
  return String(raw || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^Device\s+([0-9A-F:]{17})\s+(.+)$/i);
    if (!match) return null;
    return { mac: normalizeMac(match[1]), name: match[2].trim() };
  }).filter((device) => device?.mac && /VibeStick\s+MiniJoy/i.test(device.name));
}

function commandText(result) {
  return [result?.stdout, result?.stderr, result?.error].filter(Boolean).join("\n");
}

function bluetoothCommandSucceeded(result) {
  if (!result?.success) return false;
  return !/\b(?:failed|error|not available|not ready|authentication(?:failed| canceled))\b/i
    .test(commandText(result));
}

function deviceAlreadyAbsent(result) {
  return /\b(?:not available|does not exist)\b/i.test(commandText(result));
}

function pairingArgs(mac) {
  return [
    "--agent",
    "NoInputNoOutput",
    "--timeout",
    "30",
    "pair",
    mac,
  ];
}

function pairingWhileScanningArgs(mac) {
  return [
    "-lc",
    `bluetoothctl --timeout 35 scan on >/dev/null 2>&1 & scan_pid=$!; ` +
      `sleep 2; bluetoothctl --agent NoInputNoOutput --timeout 30 pair ${mac}; ` +
      "status=$?; kill $scan_pid 2>/dev/null || true; wait $scan_pid 2>/dev/null || true; exit $status",
  ];
}

function pipeWireCardName(mac) {
  const normalizedMac = normalizeMac(mac);
  return normalizedMac ? `bluez_card.${normalizedMac.replace(/:/g, "_")}` : "";
}

class BluetoothDeviceManager {
  constructor({
    runCommand,
    knownMacProvider = () => [],
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    this.runCommand = runCommand;
    this.knownMacProvider = knownMacProvider;
    this.wait = wait;
  }

  async info(mac) {
    const normalizedMac = normalizeMac(mac);
    if (!normalizedMac) throw Object.assign(new Error("invalid bluetooth MAC"), { statusCode: 400 });
    const result = await this.runCommand("bluetoothctl", ["info", normalizedMac], 5000);
    return parseBluetoothInfo(result?.stdout, normalizedMac);
  }

  async list() {
    const listed = await this.runCommand("bluetoothctl", ["devices"], 5000);
    const candidates = new Map(parseDeviceList(listed?.stdout).map((device) => [device.mac, device]));
    for (const value of this.knownMacProvider() || []) {
      const mac = normalizeMac(value);
      if (mac && !candidates.has(mac)) candidates.set(mac, { mac, name: "VibeStick MiniJoy" });
    }
    const devices = [];
    for (const candidate of candidates.values()) {
      const state = await this.info(candidate.mac);
      devices.push({ ...state, name: state.name || candidate.name });
    }
    return devices.sort((left, right) => left.mac.localeCompare(right.mac));
  }

  async activateAudioProfile(mac, attempts = 8) {
    const normalizedMac = normalizeMac(mac);
    const cardName = pipeWireCardName(normalizedMac);
    if (!normalizedMac) {
      return {
        success: false,
        card_name: "",
        profile: MINIJOY_HFP_PROFILE,
        detail: "invalid Bluetooth MAC",
      };
    }
    let device = await this.info(normalizedMac);
    let connectResult = null;
    if (!device.connected) {
      connectResult = await this.runCommand(
        "bluetoothctl",
        ["--timeout", "12", "connect", normalizedMac],
        15000
      );
      for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
        device = await this.info(normalizedMac);
        if (device.connected) break;
        if (attempt + 1 < attempts) await this.wait(500);
      }
      if (!device.connected) {
        return {
          success: false,
          card_name: cardName,
          profile: MINIJOY_HFP_PROFILE,
          detail: commandText(connectResult) || "Bluetooth transport did not reconnect",
        };
      }
    }
    let result = null;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      result = await this.runCommand(
        "pactl",
        ["set-card-profile", cardName, MINIJOY_HFP_PROFILE],
        5000
      );
      if (result?.success) {
        return {
          success: true,
          card_name: cardName,
          profile: MINIJOY_HFP_PROFILE,
        };
      }
      if (attempt + 1 < attempts) await this.wait(500);
    }
    return {
      success: false,
      card_name: cardName,
      profile: MINIJOY_HFP_PROFILE,
      detail: commandText(result),
    };
  }

  async resetAudioProfile(mac, attempts = 8) {
    const normalizedMac = normalizeMac(mac);
    if (!normalizedMac) {
      return {
        success: false,
        profile: MINIJOY_HFP_PROFILE,
        detail: "invalid Bluetooth MAC",
      };
    }
    const cardName = pipeWireCardName(normalizedMac);
    let device = await this.info(normalizedMac);
    if (device.connected) {
      const profileOff = await this.runCommand(
        "pactl",
        ["set-card-profile", cardName, "off"],
        5000
      );
      await this.wait(200);
      const pipeWireReset = await this.activateAudioProfile(
        normalizedMac,
        Math.min(2, Math.max(1, attempts))
      );
      if (profileOff?.success && pipeWireReset.success) {
        return {
          ...pipeWireReset,
          recovery: "pipewire_profile_reset",
        };
      }
      device = await this.info(normalizedMac);
    }

    const devicePath = `/org/bluez/hci0/dev_${normalizedMac.replace(/:/g, "_")}`;
    let profileReset = {
      success: false,
      profile: MINIJOY_HFP_PROFILE,
      detail: "Bluetooth transport is disconnected",
    };
    if (device.connected) {
      await this.runCommand("busctl", [
        "--system",
        "--timeout=2s",
        "call",
        "org.bluez",
        devicePath,
        "org.bluez.Device1",
        "DisconnectProfile",
        "s",
        MINIJOY_HFP_UUID,
      ], 3000);
      await this.wait(300);
      await this.runCommand("busctl", [
        "--system",
        "--timeout=2s",
        "call",
        "org.bluez",
        devicePath,
        "org.bluez.Device1",
        "ConnectProfile",
        "s",
        MINIJOY_HFP_UUID,
      ], 3000);
      await this.wait(500);
      profileReset = await this.activateAudioProfile(
        normalizedMac,
        Math.min(2, Math.max(1, attempts))
      );
    }
    if (profileReset.success) {
      return {
        ...profileReset,
        recovery: "hfp_profile_reset",
      };
    }

    const disconnectResult = await this.runCommand(
      "bluetoothctl",
      ["disconnect", normalizedMac],
      12000
    );
    await this.wait(500);
    const connectResult = await this.runCommand(
      "bluetoothctl",
      ["--timeout", "15", "connect", normalizedMac],
      18000
    );
    await this.wait(500);
    const transportReset = await this.activateAudioProfile(normalizedMac, attempts);
    return {
      ...transportReset,
      recovery: "device_transport_reconnect",
      ...(transportReset.success ? {} : {
        detail: [
          profileReset.detail,
          commandText(disconnectResult),
          commandText(connectResult),
          transportReset.detail,
        ].filter(Boolean).join("\n"),
      }),
    };
  }

  async repair(mac, { confirmCleanup = false, forceCleanup = false } = {}) {
    const normalizedMac = normalizeMac(mac);
    if (!normalizedMac) throw Object.assign(new Error("invalid bluetooth MAC"), { statusCode: 400 });
    let before = await this.info(normalizedMac);
    const knownMiniJoy = (this.knownMacProvider() || [])
      .map(normalizeMac)
      .includes(normalizedMac);
    if (!/VibeStick\s+MiniJoy/i.test(before.name) && !knownMiniJoy) {
      throw Object.assign(new Error("target is not a VibeStick MiniJoy"), { statusCode: 400 });
    }

    if (forceCleanup) {
      if (!confirmCleanup) {
        return {
          success: false,
          statusCode: 409,
          stage: "cleanup_confirmation_required",
          requires_cleanup: true,
          device: before,
        };
      }
      const removed = await this.runCommand("bluetoothctl", ["remove", normalizedMac], 10000);
      if (!bluetoothCommandSucceeded(removed) && !deviceAlreadyAbsent(removed)) {
        return { success: false, stage: "remove_failed", device: before, detail: commandText(removed) };
      }
      before = {
        ...before,
        paired: false,
        bonded: false,
        trusted: false,
        connected: false,
      };
    }

    if (!before.paired || !before.bonded) {
      let pair = await this.runCommand("sh", pairingWhileScanningArgs(normalizedMac), 40000);
      if (/org\.bluez\.Error\.AlreadyExists/i.test(commandText(pair))) {
        if (!confirmCleanup) {
          return {
            success: false,
            statusCode: 409,
            stage: "stale_pairing_record",
            requires_cleanup: true,
            device: before,
          };
        }
        const removed = await this.runCommand("bluetoothctl", ["remove", normalizedMac], 10000);
        if (!bluetoothCommandSucceeded(removed) && !deviceAlreadyAbsent(removed)) {
          return { success: false, stage: "remove_failed", device: before, detail: commandText(removed) };
        }
        pair = await this.runCommand("sh", pairingWhileScanningArgs(normalizedMac), 40000);
      }
      const paired = await this.info(normalizedMac);
      if (!bluetoothCommandSucceeded(pair) || !paired.paired || !paired.bonded) {
        return { success: false, stage: "pair_failed", device: before, detail: commandText(pair) };
      }
      before = paired;
    }

    const trusted = await this.runCommand("bluetoothctl", ["trust", normalizedMac], 10000);
    if (!bluetoothCommandSucceeded(trusted)) {
      return { success: false, stage: "trust_failed", device: before, detail: commandText(trusted) };
    }
    const connected = await this.runCommand("bluetoothctl", ["connect", normalizedMac], 30000);
    const after = await this.info(normalizedMac);
    const audioProfile = after.connected
      ? await this.activateAudioProfile(normalizedMac)
      : null;
    const connectedSuccessfully = after.paired &&
      after.bonded &&
      after.trusted &&
      after.connected &&
      audioProfile?.success;
    return {
      success: Boolean(connectedSuccessfully),
      stage: !after.connected
        ? "connect_failed"
        : audioProfile?.success
          ? "connected"
          : "audio_profile_failed",
      device: after,
      audio_profile: audioProfile,
      detail: connectedSuccessfully ? "" : commandText(connected),
    };
  }
}

module.exports = BluetoothDeviceManager;
module.exports.normalizeMac = normalizeMac;
module.exports.parseBluetoothInfo = parseBluetoothInfo;
module.exports.parseDeviceList = parseDeviceList;
module.exports.bluetoothCommandSucceeded = bluetoothCommandSucceeded;
module.exports.pairingArgs = pairingArgs;
module.exports.pipeWireCardName = pipeWireCardName;
module.exports.MINIJOY_HFP_PROFILE = MINIJOY_HFP_PROFILE;
module.exports.MINIJOY_HFP_UUID = MINIJOY_HFP_UUID;
