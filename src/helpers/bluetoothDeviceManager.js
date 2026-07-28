const MAC_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

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

class BluetoothDeviceManager {
  constructor({ runCommand, knownMacProvider = () => [] }) {
    this.runCommand = runCommand;
    this.knownMacProvider = knownMacProvider;
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

  async repair(mac, { confirmCleanup = false } = {}) {
    const normalizedMac = normalizeMac(mac);
    if (!normalizedMac) throw Object.assign(new Error("invalid bluetooth MAC"), { statusCode: 400 });
    let before = await this.info(normalizedMac);
    const knownMiniJoy = (this.knownMacProvider() || [])
      .map(normalizeMac)
      .includes(normalizedMac);
    if (!/VibeStick\s+MiniJoy/i.test(before.name) && !knownMiniJoy) {
      throw Object.assign(new Error("target is not a VibeStick MiniJoy"), { statusCode: 400 });
    }

    if (!before.paired || !before.bonded) {
      let pair = await this.runCommand("bluetoothctl", ["pair", normalizedMac], 30000);
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
        if (!removed?.success) {
          return { success: false, stage: "remove_failed", device: before, detail: commandText(removed) };
        }
        await this.runCommand("bluetoothctl", ["--timeout", "8", "scan", "on"], 10000);
        pair = await this.runCommand("bluetoothctl", ["pair", normalizedMac], 30000);
      }
      if (!pair?.success) {
        return { success: false, stage: "pair_failed", device: before, detail: commandText(pair) };
      }
    }

    await this.runCommand("bluetoothctl", ["trust", normalizedMac], 10000);
    await this.runCommand("bluetoothctl", ["connect", normalizedMac], 30000);
    const after = await this.info(normalizedMac);
    return {
      success: after.paired && after.bonded && after.connected,
      stage: after.connected ? "connected" : "connect_failed",
      device: after,
    };
  }
}

module.exports = BluetoothDeviceManager;
module.exports.normalizeMac = normalizeMac;
module.exports.parseBluetoothInfo = parseBluetoothInfo;
module.exports.parseDeviceList = parseDeviceList;
