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
    stopTimeoutMs = 1500,
  } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.firstChunkRetryMs = firstChunkRetryMs;
    this.maxStartAttempts = maxStartAttempts;
    this.stopTimeoutMs = stopTimeoutMs;
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
      stopPromise: null,
      finishStop: null,
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
        if (capture.child !== child || this.captures.get(id) !== capture ||
            capture.retrying || !chunk?.length) return;
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

  stop(sessionId, { drain = false } = {}) {
    const id = String(sessionId || "").trim();
    const capture = this.captures.get(id);
    if (!capture) return drain ? Promise.resolve(false) : false;
    if (drain && capture.stopPromise) return capture.stopPromise;
    const alreadyStopping = capture.stopping;
    capture.stopping = true;
    if (capture.retryTimer) clearTimeout(capture.retryTimer);
    capture.retryTimer = null;
    if (!drain) {
      this.captures.delete(id);
      capture.finishStop?.(null, false);
      capture.child.kill?.(alreadyStopping ? "SIGKILL" : "SIGTERM");
      return true;
    }

    // close follows stdout drain; exit alone can precede the final PCM chunk.
    const child = capture.child;
    const wasRunning = child.exitCode == null && child.signalCode == null;
    let stopSignalSent = false;
    capture.stopPromise = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, drained = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
        child.stdout?.removeListener("error", onError);
        if (this.captures.get(id) === capture) this.captures.delete(id);
        capture.finishStop = null;
        if (error) reject(error);
        else resolve(drained);
      };
      const onClose = (code, signal) => {
        // pw-record handles SIGTERM and exits with status 1 after draining stdout.
        const requestedStop = wasRunning && stopSignalSent && code === 1 && signal === null;
        const cleanExit = code === 0 || (code === null && signal === "SIGTERM") || requestedStop;
        finish(cleanExit ? null : new Error(`PipeWire capture stopped abnormally (${code}, ${signal})`));
      };
      const onError = (error) => {
        finish(error);
        try { child.kill?.("SIGKILL"); }
        catch (killError) {
          this.logger?.warn?.("Unable to stop failed PipeWire capture", {
            sessionId: id,
            error: killError?.message || String(killError),
          });
        }
      };
      capture.finishStop = finish;
      child.once("close", onClose);
      child.once("error", onError);
      child.stdout?.once("error", onError);
      timer = setTimeout(() => {
        const error = new Error(`PipeWire capture stop timed out (${this.stopTimeoutMs}ms)`);
        error.code = "PIPEWIRE_CAPTURE_STOP_TIMEOUT";
        onError(error);
      }, this.stopTimeoutMs);
      try { stopSignalSent = child.kill?.("SIGTERM") === true; }
      catch (error) { onError(error); }
    });
    return capture.stopPromise;
  }

  stopAll() {
    for (const sessionId of this.captures.keys()) {
      this.stop(sessionId);
    }
  }
}

module.exports = PipeWireCaptureController;
module.exports.nodeNameFromSourceId = nodeNameFromSourceId;
