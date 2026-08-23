const DEFAULT_DEVICE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_ONLINE_MS = 30 * 1000;

function normalizeRemoteAddress(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class M5DeviceRegistry {
  constructor({
    retentionMs = DEFAULT_DEVICE_RETENTION_MS,
    onlineMs = DEFAULT_DEVICE_ONLINE_MS,
    now = Date.now,
  } = {}) {
    this.retentionMs = retentionMs;
    this.onlineMs = onlineMs;
    this.now = now;
    this.devices = new Map();
  }

  remember(req, requestPath) {
    const firmwareName = String(req.headers["x-vibe-stick-firmware-name"] || "").trim();
    const deviceId = String(req.headers["x-vibe-stick-device-id"] || "").trim();
    if (!firmwareName && !deviceId) {
      return null;
    }

    const now = this.now();
    const clientIp = normalizeRemoteAddress(
      req.headers["x-vibe-ingress-client-ip"] || req.socket?.remoteAddress || ""
    );
    const key = deviceId || clientIp || "unknown-device";
    const previous = this.devices.get(key) || {};
    const device = {
      device_id: key,
      client_ip: clientIp,
      path: requestPath,
      last_seen: now,
      last_seen_text: new Date(now).toLocaleString(),
      firmware_name: firmwareName,
      firmware_version: String(req.headers["x-vibe-stick-firmware-version"] || ""),
      transport: String(req.headers["x-vibe-stick-firmware-transport"] || ""),
      build_date: String(req.headers["x-vibe-stick-firmware-build-date"] || ""),
      board: String(req.headers["x-vibe-stick-board"] || ""),
      device_ip: String(req.headers["x-vibe-stick-device-ip"] || clientIp),
      wifi_ssid: String(req.headers["x-vibe-stick-wifi-ssid"] || ""),
      wifi_bssid: String(req.headers["x-vibe-stick-wifi-bssid"] || ""),
      wifi_rssi: parseInteger(req.headers["x-vibe-stick-wifi-rssi"], previous.wifi_rssi ?? null),
      wake_cause: String(req.headers["x-vibe-stick-wake-cause"] || ""),
      wake_cause_code: String(req.headers["x-vibe-stick-wake-cause-code"] || ""),
      wake_ext1: String(req.headers["x-vibe-stick-wake-ext1"] || ""),
      reset_reason: String(req.headers["x-vibe-stick-reset-reason"] || ""),
      reset_reason_code: String(req.headers["x-vibe-stick-reset-reason-code"] || ""),
      boot_count: String(req.headers["x-vibe-stick-boot-count"] || ""),
      input_profile_revision: parseInteger(
        req.headers["x-vibe-stick-input-profile-revision"],
        previous.input_profile_revision ?? 0
      ),
      pmic_wake: String(req.headers["x-vibe-stick-pmic-wake"] || ""),
      pmic_irq: String(req.headers["x-vibe-stick-pmic-irq"] || ""),
      pmic_timer: String(req.headers["x-vibe-stick-pmic-timer"] || ""),
      pmic_gpio_wake: String(req.headers["x-vibe-stick-pmic-gpio-wake"] || ""),
    };
    this.devices.set(key, device);
    this.prune(now);
    return device;
  }

  prune(now = this.now()) {
    for (const [key, device] of this.devices.entries()) {
      if (now - Number(device.last_seen || 0) > this.retentionMs) {
        this.devices.delete(key);
      }
    }
  }

  list() {
    this.prune();
    return [...this.devices.values()].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  }

  listOnline(now = this.now()) {
    this.prune(now);
    return [...this.devices.values()]
      .filter((device) => now - Number(device.last_seen || 0) <= this.onlineMs)
      .map((device) => ({
        ...device,
        online: true,
        age_ms: Math.max(0, now - Number(device.last_seen || 0)),
      }))
      .sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  }

  listOffline(now = this.now()) {
    this.prune(now);
    return [...this.devices.values()]
      .filter((device) => now - Number(device.last_seen || 0) > this.onlineMs)
      .map((device) => ({
        ...device,
        online: false,
        age_ms: Math.max(0, now - Number(device.last_seen || 0)),
      }))
      .sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  }
}

module.exports = M5DeviceRegistry;
module.exports.DEFAULT_DEVICE_RETENTION_MS = DEFAULT_DEVICE_RETENTION_MS;
module.exports.DEFAULT_DEVICE_ONLINE_MS = DEFAULT_DEVICE_ONLINE_MS;
module.exports.normalizeRemoteAddress = normalizeRemoteAddress;
module.exports.parseInteger = parseInteger;
