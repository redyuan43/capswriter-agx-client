const { execFileSync } = require("child_process");

const BUS_SINK_NAME = "capswriter_input_bus";
const UNIFIED_SOURCE_NAME = `${BUS_SINK_NAME}.monitor`;

class PipeWireUnifiedSourceController {
  constructor({ logger = null, runCommand = execFileSync } = {}) {
    this.logger = logger;
    this.runCommand = runCommand;
    this.activeSource = "";
    this.activeSink = "";
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

  listStreams(kind) {
    try {
      return JSON.parse(this.command(["-f", "json", "list", kind]) || "[]");
    } catch (error) {
      this.logger?.warn?.("Failed to enumerate PipeWire streams", {
        kind,
        error: error?.message || String(error),
      });
      return [];
    }
  }

  shouldMoveStream(stream) {
    const properties = stream?.properties || {};
    return !stream?.owner_module &&
      properties["stream.monitor"] !== "true" &&
      properties["application.name"] !== "CapsWriter_Native_Capture";
  }

  moveExistingStreams(kind, targetNodeName) {
    const command = kind === "sink-inputs" ? "move-sink-input" : "move-source-output";
    const moved = [];
    for (const stream of this.listStreams(kind)) {
      if (!this.shouldMoveStream(stream) || stream?.index === undefined) continue;
      try {
        this.command([command, String(stream.index), targetNodeName]);
        moved.push(stream.index);
      } catch (error) {
        this.logger?.warn?.("Failed to move PipeWire stream", {
          kind,
          streamIndex: stream.index,
          targetNodeName,
          error: error?.message || String(error),
        });
      }
    }
    return moved;
  }

  setDefaultSource(sourceNodeName, { moveExisting = true } = {}) {
    const nodeName = String(sourceNodeName || "").trim();
    if (!nodeName) throw new Error("PipeWire source node is required");
    this.command(["set-default-source", nodeName]);
    const movedSourceOutputs = moveExisting
      ? this.moveExistingStreams("source-outputs", nodeName)
      : [];
    this.activeSource = nodeName;
    return {
      default_source_name: nodeName,
      moved_source_outputs: movedSourceOutputs,
    };
  }

  setDefaultSink(sinkNodeName, { moveExisting = true } = {}) {
    const nodeName = String(sinkNodeName || "").trim();
    if (!nodeName) throw new Error("PipeWire sink node is required");
    this.command(["set-default-sink", nodeName]);
    const movedSinkInputs = moveExisting
      ? this.moveExistingStreams("sink-inputs", nodeName)
      : [];
    this.activeSink = nodeName;
    return {
      default_sink_name: nodeName,
      moved_sink_inputs: movedSinkInputs,
    };
  }

  activate(sourceNodeName, sinkNodeName = "") {
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
    const sourceResult = this.setDefaultSource(nodeName);
    const sinkResult = sinkNodeName
      ? this.setDefaultSink(sinkNodeName)
      : { default_sink_name: this.activeSink, moved_sink_inputs: [] };
    this.logger?.info?.("Unified PipeWire route switched", {
      sourceNodeName: nodeName,
      sinkNodeName: sinkResult.default_sink_name || null,
      unifiedSource: UNIFIED_SOURCE_NAME,
    });
    return {
      source_node_name: nodeName,
      unified_source_name: UNIFIED_SOURCE_NAME,
      ...sourceResult,
      ...sinkResult,
    };
  }

  deactivate() {
    this.unloadExistingLoopbacks();
    const previousSource = this.activeSource;
    const previousSink = this.activeSink;
    this.activeSource = "";
    this.activeSink = "";
    this.logger?.info?.("Unified PipeWire route released", {
      previousSource,
      previousSink,
    });
    return {
      previous_source_node_name: previousSource,
      previous_sink_node_name: previousSink,
    };
  }
}

module.exports = PipeWireUnifiedSourceController;
module.exports.BUS_SINK_NAME = BUS_SINK_NAME;
module.exports.UNIFIED_SOURCE_NAME = UNIFIED_SOURCE_NAME;
