const { spawn } = require("child_process");

function nodeNameFromSourceId(sourceId) {
  const value = String(sourceId || "").trim();
  return value.startsWith("pipewire:") ? value.slice("pipewire:".length) : "";
}

class PipeWireCaptureController {
  constructor({ logger = null, spawnProcess = spawn } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.captures = new Map();
  }

  start(sessionId, sourceId, onChunk, nodeNameOverride = "", options = {}) {
    const id = String(sessionId || "").trim();
    const nodeName = String(nodeNameOverride || nodeNameFromSourceId(sourceId)).trim();
    if (!id || !nodeName) {
      throw new Error("session_id and PipeWire source are required");
    }
    this.stop(id);
    const child = this.spawnProcess("parec", [
      "--raw",
      `--device=${nodeName}`,
      "--rate=16000",
      "--channels=1",
      "--format=s16le",
      "--latency-msec=40",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      if (chunk?.length) onChunk?.(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const capture = { child, stopping: false };
    child.on("close", (code, signal) => {
      this.captures.delete(id);
      if (code && code !== 0) {
        this.logger?.warn?.("PipeWire capture exited", {
          sessionId: id,
          sourceId,
          code,
          signal,
          stderr: stderr.trim(),
        });
      }
      if (!capture.stopping) {
        options.onUnexpectedExit?.({
          sessionId: id,
          sourceId,
          code,
          signal,
          stderr: stderr.trim(),
        });
      }
    });
    child.on("error", (error) => {
      this.captures.delete(id);
      this.logger?.warn?.("PipeWire capture failed", {
        sessionId: id,
        sourceId,
        error: error?.message || String(error),
      });
      if (!capture.stopping) {
        options.onUnexpectedExit?.({
          sessionId: id,
          sourceId,
          error: error?.message || String(error),
          stderr: stderr.trim(),
        });
      }
    });
    this.captures.set(id, capture);
    return { session_id: id, source_id: sourceId, pid: child.pid || null };
  }

  stop(sessionId) {
    const id = String(sessionId || "").trim();
    const capture = this.captures.get(id);
    if (!capture) return false;
    this.captures.delete(id);
    capture.stopping = true;
    capture.child.kill?.("SIGTERM");
    return true;
  }

  stopAll() {
    for (const sessionId of this.captures.keys()) {
      this.stop(sessionId);
    }
  }
}

module.exports = PipeWireCaptureController;
module.exports.nodeNameFromSourceId = nodeNameFromSourceId;
