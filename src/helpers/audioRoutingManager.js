const { execFileSync } = require("child_process");

const ROUTING_SETTING_KEY = "audio_input_routes_v2";
const LEGACY_ROUTING_SETTING_KEY = "audio_input_routes_v1";
const DEFAULT_USB_DESCRIPTION = "MI Speakphone Mono";
const UNIFIED_SOURCE_NAME = "capswriter_input_bus.monitor";

function cleanId(value) {
  return String(value || "").trim();
}

function normalizeBluetoothAddress(value) {
  const hex = cleanId(value).toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex : "";
}

function bluetoothAddressFromSource(source) {
  const properties = source?.properties || {};
  const explicit = normalizeBluetoothAddress(
    source?.bluetooth_address ||
    properties["api.bluez5.address"] ||
    properties["device.string"]
  );
  if (explicit) return explicit;
  const nodeName = cleanId(source?.stable_node_name || source?.name || properties["node.name"]);
  return normalizeBluetoothAddress(nodeName.match(/bluez_input\.([0-9a-f_:-]{17})/i)?.[1] || "");
}

function miniJoyTriggerId(address) {
  const normalized = normalizeBluetoothAddress(address);
  return normalized ? `minijoy_bt:${normalized}` : "minijoy_bt";
}

function miniJoyTriggerLabel(triggerId) {
  const address = normalizeBluetoothAddress(String(triggerId || "").split(":").slice(1).join(":"));
  return address ? `MiniJoy ${address.slice(-4, -2).toUpperCase()}:${address.slice(-2).toUpperCase()}` : "MiniJoy 蓝牙按键";
}

function stableNodeName(value) {
  return cleanId(value).replace(/\.\d+$/, "");
}

function sourceIdForPipeWire(source) {
  const properties = source?.properties || {};
  const nodeName = stableNodeName(source?.name || properties["node.name"]);
  return nodeName ? `pipewire:${nodeName}` : "";
}

function normalizeRoutes(value) {
  const routes = value && typeof value === "object" ? value.routes : null;
  const normalized = {};
  if (routes && typeof routes === "object") {
    for (const [triggerId, route] of Object.entries(routes)) {
      const sourceId = cleanId(route?.source_id || route);
      if (cleanId(triggerId) && sourceId) {
        normalized[cleanId(triggerId)] = { source_id: sourceId };
      }
    }
  }
  return { version: 2, routes: normalized };
}

class AudioRoutingManager {
  constructor({
    databaseManager = null,
    logger = null,
    runCommand = execFileSync,
    wifiDeviceProvider = () => [],
    now = () => Date.now(),
  } = {}) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    this.runCommand = runCommand;
    this.wifiDeviceProvider = wifiDeviceProvider;
    this.now = now;
    this.activeRoutes = new Map();
    this.captureHealth = new Map();
  }

  captureHealthFor(sourceId) {
    return this.captureHealth.get(cleanId(sourceId)) || {
      status: "unknown",
      last_success_at: null,
      last_failure_at: null,
      failure_reason: "",
    };
  }

  recordCaptureSuccess(sourceId, details = {}) {
    const id = cleanId(sourceId);
    if (!id) return null;
    const previous = this.captureHealthFor(id);
    const health = {
      ...previous,
      status: "healthy",
      last_success_at: new Date(this.now()).toISOString(),
      failure_reason: "",
      last_success_bytes: Math.max(0, Number(details.bytes || 0)),
    };
    this.captureHealth.set(id, health);
    return health;
  }

  recordCaptureFailure(sourceId, reason, details = {}) {
    const id = cleanId(sourceId);
    if (!id) return null;
    const previous = this.captureHealthFor(id);
    const health = {
      ...previous,
      status: "failed",
      last_failure_at: new Date(this.now()).toISOString(),
      failure_reason: cleanId(reason) || "audio_capture_failed",
      failure_details: details && typeof details === "object" ? details : {},
    };
    this.captureHealth.set(id, health);
    return health;
  }

  loadRoutes() {
    const current = this.databaseManager?.getSetting?.(ROUTING_SETTING_KEY, null);
    if (current) return normalizeRoutes(current);
    return normalizeRoutes(
      this.databaseManager?.getSetting?.(LEGACY_ROUTING_SETTING_KEY, { version: 1, routes: {} })
    );
  }

  saveRoutes(value) {
    const normalized = normalizeRoutes(value);
    this.databaseManager?.setSetting?.(ROUTING_SETTING_KEY, normalized);
    return normalized;
  }

  routesForSources(sources) {
    const saved = this.loadRoutes();
    const legacy = saved.routes.minijoy_bt;
    if (!legacy) return saved;
    const source = sources.find((candidate) => candidate.source_id === legacy.source_id);
    if (!source?.bluetooth_address) return saved;
    const triggerId = miniJoyTriggerId(source.bluetooth_address);
    if (!saved.routes[triggerId]) saved.routes[triggerId] = { ...legacy };
    delete saved.routes.minijoy_bt;
    this.databaseManager?.setSetting?.(ROUTING_SETTING_KEY, saved);
    return saved;
  }

  listPipeWireSources() {
    if (process.platform !== "linux") {
      return [];
    }
    try {
      const output = this.runCommand(
        "pactl",
        ["-f", "json", "list", "sources"],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }
      );
      const sources = JSON.parse(String(output || "[]"));
      return sources
        .filter((source) => !String(source?.name || "").endsWith(".monitor"))
        .map((source) => {
          const properties = source.properties || {};
          const nodeName = cleanId(source.name || properties["node.name"]);
          const stableName = stableNodeName(nodeName);
          const description = cleanId(source.description || properties["device.description"] || nodeName);
          const bluetooth = stableName.startsWith("bluez_input.") ||
            /VibeStick MiniJoy/i.test(description);
          const bluetoothAddress = bluetoothAddressFromSource({
            name: nodeName,
            stable_node_name: stableName,
            properties,
          });
          const sourceId = sourceIdForPipeWire(source);
          const transportAvailable = String(source.state || "").toUpperCase() !== "UNAVAILABLE";
          return {
            source_id: sourceId,
            kind: "pipewire",
            node_name: nodeName,
            stable_node_name: stableName,
            name: bluetooth && bluetoothAddress
              ? `${description} ${bluetoothAddress.slice(-4, -2).toUpperCase()}:${bluetoothAddress.slice(-2).toUpperCase()}`
              : description,
            base_name: description,
            enumerated: true,
            transport_available: transportAvailable,
            online: transportAvailable,
            audio_health: this.captureHealthFor(sourceId),
            bluetooth,
            bluetooth_address: bluetoothAddress,
            trigger_id: bluetooth ? miniJoyTriggerId(bluetoothAddress) : "",
            unified: stableName === UNIFIED_SOURCE_NAME,
            properties,
          };
        })
        .filter((source) => source.source_id);
    } catch (error) {
      this.logger?.warn?.("Failed to enumerate PipeWire sources", {
        error: error?.message || String(error),
      });
      return [];
    }
  }

  listWifiSources() {
    return this.wifiDeviceProvider()
      .map((device) => {
        const deviceId = cleanId(device.device_id);
        if (!deviceId) return null;
        return {
          source_id: `wifi:${deviceId}`,
          kind: "wifi",
          device_id: deviceId,
          name: [device.board || "VibeStick", device.device_ip || device.client_ip]
            .filter(Boolean)
            .join(" "),
          online: true,
          firmware_version: cleanId(device.firmware_version),
        };
      })
      .filter(Boolean);
  }

  listSources() {
    return [...this.listPipeWireSources(), ...this.listWifiSources()];
  }

  defaultSourceForTrigger(triggerId, sources = this.listSources()) {
    if (triggerId.startsWith("minijoy_bt:")) {
      const address = normalizeBluetoothAddress(triggerId.slice("minijoy_bt:".length));
      return sources.find((source) =>
        source.kind === "pipewire" && source.bluetooth_address === address
      )?.source_id || "";
    }
    if (triggerId === "minijoy_bt") {
      return sources.find((source) => source.kind === "pipewire" && source.bluetooth)?.source_id || "";
    }
    if (triggerId.startsWith("wifi:")) {
      const sameDevice = sources.find((source) => source.source_id === triggerId);
      return sameDevice?.source_id || "";
    }
    return sources.find((source) =>
      source.kind === "pipewire" &&
      source.name === DEFAULT_USB_DESCRIPTION
    )?.source_id || sources.find((source) =>
      source.kind === "pipewire" && !source.unified
    )?.source_id || "";
  }

  resolveRoute(triggerId, sources = this.listSources(), saved = this.routesForSources(sources)) {
    const cleanTriggerId = cleanId(triggerId) || "keyboard";
    const sourceId = cleanId(saved.routes[cleanTriggerId]?.source_id) ||
      this.defaultSourceForTrigger(cleanTriggerId, sources);
    const source = sources.find((candidate) => candidate.source_id === sourceId) || {
      source_id: sourceId,
      kind: sourceId.startsWith("wifi:") ? "wifi" : "pipewire",
      name: sourceId,
      online: false,
    };
    return {
      trigger_id: cleanTriggerId,
      source_id: sourceId,
      source,
      trigger_name: miniJoyTriggerLabel(cleanTriggerId),
      available: Boolean(sourceId && (source.transport_available ?? source.online)),
    };
  }

  activateTrigger(triggerId) {
    const route = this.resolveRoute(triggerId);
    const activeRoute = {
      ...route,
      activated_at: Date.now(),
    };
    this.activeRoutes.set(route.trigger_id, activeRoute);
    this.logger?.info?.("Audio input route activated", activeRoute);
    return activeRoute;
  }

  clearActiveRoute(triggerId = "") {
    if (!triggerId) this.activeRoutes.clear();
    else this.activeRoutes.delete(triggerId);
  }

  getState() {
    const sources = this.listSources();
    const saved = this.routesForSources(sources);
    const bluetoothTriggerIds = sources
      .filter((source) => source.bluetooth && source.bluetooth_address)
      .map((source) => miniJoyTriggerId(source.bluetooth_address));
    const triggerIds = new Set([
      "keyboard",
      ...bluetoothTriggerIds,
      ...(bluetoothTriggerIds.length ? [] : ["minijoy_bt"]),
      ...this.listWifiSources().map((source) => source.source_id),
      ...Object.keys(saved.routes),
    ]);
    const routes = {};
    for (const triggerId of triggerIds) {
      routes[triggerId] = this.resolveRoute(triggerId, sources, saved);
    }
    return {
      version: 2,
      unified_source: {
        source_id: `pipewire:${UNIFIED_SOURCE_NAME}`,
        node_name: UNIFIED_SOURCE_NAME,
        name: "CapsWriter Unified Input",
      },
      sources,
      routes,
      active_route: [...this.activeRoutes.values()].at(-1) || null,
      active_routes: [...this.activeRoutes.values()],
    };
  }
}

module.exports = AudioRoutingManager;
module.exports.ROUTING_SETTING_KEY = ROUTING_SETTING_KEY;
module.exports.LEGACY_ROUTING_SETTING_KEY = LEGACY_ROUTING_SETTING_KEY;
module.exports.DEFAULT_USB_DESCRIPTION = DEFAULT_USB_DESCRIPTION;
module.exports.UNIFIED_SOURCE_NAME = UNIFIED_SOURCE_NAME;
module.exports.normalizeRoutes = normalizeRoutes;
module.exports.sourceIdForPipeWire = sourceIdForPipeWire;
module.exports.stableNodeName = stableNodeName;
module.exports.normalizeBluetoothAddress = normalizeBluetoothAddress;
module.exports.bluetoothAddressFromSource = bluetoothAddressFromSource;
module.exports.miniJoyTriggerId = miniJoyTriggerId;
module.exports.miniJoyTriggerLabel = miniJoyTriggerLabel;
