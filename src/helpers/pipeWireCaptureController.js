const { spawn } = require("child_process");

function nodeNameFromSourceId(sourceId) {
  const value = String(sourceId || "").trim();
  return value.startsWith("pipewire:") ? value.slice("pipewire:".length) : "";
}

class PipeWireCaptureController {
  constructor({
    logger = null,
    spawnProcess = spawn,
    firstChunkRetryMs = 1000,
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
      retrying: false,
      retryTimer: null,
      attempt: 0,
      receivedAudio: false,
    };
    const firstChunkRetryMs = Math.max(
      1,
      Number(options.firstChunkRetryMs || this.firstChunkRetryMs)
    );
    const maxStartAttempts = Math.max(
      1,
      Number(options.maxStartAttempts || this.maxStartAttempts)
    );
    this.captures.set(id, capture);

    const clearRetryTimer = () => {
      if (capture.retryTimer) {
        clearTimeout(capture.retryTimer);
        capture.retryTimer = null;
      }
    };

    const retryCapture = (child, reason, details = {}) => {
      if (capture.stopping || capture.retrying || capture.child !== child ||
          this.captures.get(id) !== capture || capture.receivedAudio) {
        return false;
      }
      if (capture.attempt >= maxStartAttempts) {
        if (reason === "invalid_audio") {
          clearRetryTimer();
          this.captures.delete(id);
          capture.stopping = true;
          child.kill?.("SIGTERM");
          options.onInvalidAudio?.({
            sessionId: id,
            sourceId,
            attempt: capture.attempt,
            ...details,
          });
        }
        return false;
      }
      capture.retrying = true;
      clearRetryTimer();
      this.logger?.warn?.(
        reason === "invalid_audio"
          ? "PipeWire capture produced invalid PCM, retrying"
          : "PipeWire capture produced no audio, retrying",
        {
          sessionId: id,
          sourceId,
          attempt: capture.attempt,
          ...details,
        }
      );
      Promise.resolve(options.beforeRetry?.({
        sessionId: id,
        sourceId,
        attempt: capture.attempt,
        reason,
        ...details,
      })).catch((error) => {
        this.logger?.warn?.("PipeWire capture retry preparation failed", {
          sessionId: id,
          sourceId,
          error: error?.message || String(error),
        });
      }).finally(() => {
        if (capture.stopping || capture.child !== child || this.captures.get(id) !== capture) {
          return;
        }
        capture.retrying = false;
        launch();
        child.kill?.("SIGTERM");
      });
      return true;
    };

    const launch = () => {
      clearRetryTimer();
      capture.attempt += 1;
      capture.retrying = false;
      let stderr = "";
      const initialAudioBytes = Math.max(0, Number(options.initialAudioBytes || 0));
      const maxInitialAudioBytes = Math.max(
        initialAudioBytes,
        Number(options.maxInitialAudioBytes || initialAudioBytes)
      );
      const deferredInvalidAudioReasons = new Set(
        Array.isArray(options.deferredInvalidAudioReasons)
          ? options.deferredInvalidAudioReasons.map((reason) => String(reason || ""))
          : []
      );
      const validateInitialAudio = typeof options.validateInitialAudio === "function"
        ? options.validateInitialAudio
        : null;
      const initialChunks = [];
      let initialBytes = 0;
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
        if (capture.child !== child || capture.retrying || !chunk?.length) return;
        if (!capture.receivedAudio && validateInitialAudio && initialAudioBytes > 0) {
          const bufferedChunk = Buffer.from(chunk);
          initialChunks.push(bufferedChunk);
          initialBytes += bufferedChunk.length;
          if (initialBytes < initialAudioBytes) return;
          const initialAudio = Buffer.concat(initialChunks, initialBytes);
          const validationBytes = Math.min(initialBytes, maxInitialAudioBytes);
          const validation = validateInitialAudio(initialAudio.subarray(0, validationBytes));
          if (!validation?.valid) {
            if (
              initialBytes < maxInitialAudioBytes &&
              deferredInvalidAudioReasons.has(String(validation?.reason || ""))
            ) {
              return;
            }
            retryCapture(child, "invalid_audio", {
              validationReason: validation?.reason || "invalid_pcm",
              metrics: validation?.metrics || null,
            });
            return;
          }
          capture.receivedAudio = true;
          clearRetryTimer();
          for (const buffered of initialChunks) onChunk?.(buffered);
          return;
        }
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
        if (capture.retrying) return;
        if (capture.stopping) {
          this.captures.delete(id);
          return;
        }
        if (!capture.receivedAudio && capture.attempt < maxStartAttempts) {
          retryCapture(child, "capture_exited", {
            code,
            signal,
            stderr: stderr.trim(),
          });
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
        if (capture.retrying) return;
        if (!capture.stopping && !capture.receivedAudio &&
            capture.attempt < maxStartAttempts) {
          retryCapture(child, "capture_error", {
            error: error?.message || String(error),
            stderr: stderr.trim(),
          });
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
        retryCapture(child, "no_audio");
      }, firstChunkRetryMs);
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
