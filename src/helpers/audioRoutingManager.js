const { execFileSync } = require("child_process");

const ROUTING_SETTING_KEY = "audio_input_routes_v1";
const DEFAULT_USB_DESCRIPTION = "MI Speakphone Mono";
const UNIFIED_SOURCE_NAME = "capswriter_input_bus.monitor";

function cleanId(value) {
  return String(value || "").trim();
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
  return { version: 1, routes: normalized };
}

class AudioRoutingManager {
  constructor({
    databaseManager = null,
    logger = null,
    runCommand = execFileSync,
    wifiDeviceProvider = () => [],
  } = {}) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    this.runCommand = runCommand;
    this.wifiDeviceProvider = wifiDeviceProvider;
    this.activeRoute = null;
  }

  loadRoutes() {
    return normalizeRoutes(
      this.databaseManager?.getSetting?.(ROUTING_SETTING_KEY, { version: 1, routes: {} })
    );
  }

  saveRoutes(value) {
    const normalized = normalizeRoutes(value);
    this.databaseManager?.setSetting?.(ROUTING_SETTING_KEY, normalized);
    return normalized;
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
          return {
            source_id: sourceIdForPipeWire(source),
            kind: "pipewire",
            node_name: nodeName,
            stable_node_name: stableName,
            name: description,
            online: String(source.state || "").toUpperCase() !== "UNAVAILABLE",
            bluetooth,
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

  resolveRoute(triggerId) {
    const cleanTriggerId = cleanId(triggerId) || "keyboard";
    const sources = this.listSources();
    const saved = this.loadRoutes();
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
      available: Boolean(sourceId && source.online),
    };
  }

  activateTrigger(triggerId) {
    const route = this.resolveRoute(triggerId);
    this.activeRoute = {
      ...route,
      activated_at: Date.now(),
    };
    this.logger?.info?.("Audio input route activated", this.activeRoute);
    return this.activeRoute;
  }

  clearActiveRoute(triggerId = "") {
    if (!this.activeRoute) return;
    if (!triggerId || this.activeRoute.trigger_id === triggerId) {
      this.activeRoute = null;
    }
  }

  getState() {
    const sources = this.listSources();
    const saved = this.loadRoutes();
    const triggerIds = new Set([
      "keyboard",
      "minijoy_bt",
      ...this.listWifiSources().map((source) => source.source_id),
      ...Object.keys(saved.routes),
    ]);
    const routes = {};
    for (const triggerId of triggerIds) {
      routes[triggerId] = this.resolveRoute(triggerId);
    }
    return {
      version: 1,
      unified_source: {
        source_id: `pipewire:${UNIFIED_SOURCE_NAME}`,
        node_name: UNIFIED_SOURCE_NAME,
        name: "CapsWriter Unified Input",
      },
      sources,
      routes,
      active_route: this.activeRoute,
    };
  }
}

module.exports = AudioRoutingManager;
module.exports.ROUTING_SETTING_KEY = ROUTING_SETTING_KEY;
module.exports.DEFAULT_USB_DESCRIPTION = DEFAULT_USB_DESCRIPTION;
module.exports.UNIFIED_SOURCE_NAME = UNIFIED_SOURCE_NAME;
module.exports.normalizeRoutes = normalizeRoutes;
module.exports.sourceIdForPipeWire = sourceIdForPipeWire;
module.exports.stableNodeName = stableNodeName;
