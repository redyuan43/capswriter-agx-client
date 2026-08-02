const { spawn } = require("child_process");

function nodeNameFromSourceId(sourceId) {
  const value = String(sourceId || "").trim();
  return value.startsWith("pipewire:") ? value.slice("pipewire:".length) : "";
}

class PipeWireCaptureController {
  constructor({
    logger = null,
    spawnProcess = spawn,
    firstChunkRetryMs = 300,
    maxStartAttempts = 3,
  } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.firstChunkRetryMs = firstChunkRetryMs;
    this.maxStartAttempts = maxStartAttempts;
    this.captures = new Map();
  }

  start(sessionId, sourceId, onChunk, nodeNameOverride = "", options = {}) {
    const id = String(sessionId || "").trim();
    const nodeName = String(nodeNameOverride || nodeNameFromSourceId(sourceId)).trim();
    if (!id || !nodeName) {
      throw new Error("session_id and PipeWire source are required");
    }
    const runtimeDir = String(
      process.env.PIPEWIRE_RUNTIME_DIR ||
      process.env.XDG_RUNTIME_DIR ||
      (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "")
    ).trim();
    this.stop(id);
    const capture = {
      child: null,
      stopping: false,
      retryTimer: null,
      attempt: 0,
      receivedAudio: false,
    };
    this.captures.set(id, capture);

    const clearRetryTimer = () => {
      if (capture.retryTimer) {
        clearTimeout(capture.retryTimer);
        capture.retryTimer = null;
      }
    };

    const launch = () => {
      clearRetryTimer();
      capture.attempt += 1;
      let stderr = "";
      const child = this.spawnProcess("pw-record", [
        "--properties",
        `application.name=CapsWriter_Native_Capture node.name=capswriter_capture_${id}`,
        "--target",
        nodeName,
        "--rate",
        "16000",
        "--channels",
        "1",
        "--format",
        "s16",
        "--latency",
        "40ms",
        "-",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(runtimeDir ? {
            PIPEWIRE_RUNTIME_DIR: runtimeDir,
            PULSE_SERVER: process.env.PULSE_SERVER || `unix:${runtimeDir}/pulse/native`,
          } : {}),
          PIPEWIRE_REMOTE: process.env.PIPEWIRE_REMOTE || "pipewire-0",
        },
      });
      capture.child = child;

      child.stdout?.on("data", (chunk) => {
        if (capture.child !== child || !chunk?.length) return;
        capture.receivedAudio = true;
        clearRetryTimer();
        onChunk?.(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code, signal) => {
        if (capture.child !== child || this.captures.get(id) !== capture) return;
        clearRetryTimer();
        if (capture.stopping) {
          this.captures.delete(id);
          return;
        }
        if (!capture.receivedAudio && capture.attempt < this.maxStartAttempts) {
          launch();
          return;
        }
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
        options.onUnexpectedExit?.({
          sessionId: id,
          sourceId,
          code,
          signal,
          stderr: stderr.trim(),
        });
      });
      child.on("error", (error) => {
        if (capture.child !== child || this.captures.get(id) !== capture) return;
        clearRetryTimer();
        if (!capture.stopping && !capture.receivedAudio &&
            capture.attempt < this.maxStartAttempts) {
          launch();
          return;
        }
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

      capture.retryTimer = setTimeout(() => {
        capture.retryTimer = null;
        if (capture.stopping || capture.child !== child || capture.receivedAudio) return;
        if (capture.attempt >= this.maxStartAttempts) return;
        this.logger?.warn?.("PipeWire capture produced no audio, retrying", {
          sessionId: id,
          sourceId,
          attempt: capture.attempt,
        });
        launch();
        child.kill?.("SIGTERM");
      }, this.firstChunkRetryMs);
      capture.retryTimer.unref?.();
    };

    launch();
    return { session_id: id, source_id: sourceId, pid: capture.child?.pid || null };
  }

  stop(sessionId) {
    const id = String(sessionId || "").trim();
    const capture = this.captures.get(id);
    if (!capture) return false;
    this.captures.delete(id);
    capture.stopping = true;
    if (capture.retryTimer) clearTimeout(capture.retryTimer);
    capture.retryTimer = null;
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
