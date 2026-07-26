const { execFileSync } = require("child_process");

const BUS_SINK_NAME = "capswriter_input_bus";
const UNIFIED_SOURCE_NAME = `${BUS_SINK_NAME}.monitor`;

class PipeWireUnifiedSourceController {
  constructor({ logger = null, runCommand = execFileSync } = {}) {
    this.logger = logger;
    this.runCommand = runCommand;
    this.activeSource = "";
  }

  command(args) {
    return String(this.runCommand("pactl", args, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }) || "");
  }

  ensureBus() {
    const sinks = JSON.parse(this.command(["-f", "json", "list", "sinks"]) || "[]");
    if (!sinks.some((sink) => sink.name === BUS_SINK_NAME)) {
      this.command([
        "load-module",
        "module-null-sink",
        `sink_name=${BUS_SINK_NAME}`,
        "sink_properties=device.description=CapsWriter_Input_Bus",
      ]);
    }
    return UNIFIED_SOURCE_NAME;
  }

  unloadExistingLoopbacks() {
    const modules = this.command(["list", "short", "modules"]);
    for (const line of modules.split("\n")) {
      const [moduleId, moduleName, ...argumentParts] = line.trim().split(/\s+/);
      const argumentsText = argumentParts.join(" ");
      if (
        moduleId &&
        moduleName === "module-loopback" &&
        argumentsText.includes(`sink=${BUS_SINK_NAME}`)
      ) {
        this.command(["unload-module", moduleId]);
      }
    }
  }

  activate(sourceNodeName) {
    const nodeName = String(sourceNodeName || "").trim();
    if (!nodeName) throw new Error("PipeWire source node is required");
    this.ensureBus();
    this.unloadExistingLoopbacks();
    this.command([
      "load-module",
      "module-loopback",
      `source=${nodeName}`,
      `sink=${BUS_SINK_NAME}`,
      "latency_msec=20",
      "source_dont_move=true",
      "sink_dont_move=true",
    ]);
    this.command(["set-default-source", UNIFIED_SOURCE_NAME]);
    this.activeSource = nodeName;
    this.logger?.info?.("Unified PipeWire input switched", {
      sourceNodeName: nodeName,
      unifiedSource: UNIFIED_SOURCE_NAME,
    });
    return {
      source_node_name: nodeName,
      unified_source_name: UNIFIED_SOURCE_NAME,
    };
  }
}

module.exports = PipeWireUnifiedSourceController;
module.exports.BUS_SINK_NAME = BUS_SINK_NAME;
module.exports.UNIFIED_SOURCE_NAME = UNIFIED_SOURCE_NAME;
